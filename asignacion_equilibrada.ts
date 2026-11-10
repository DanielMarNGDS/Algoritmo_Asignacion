/**
 * Asignación automática y equilibrada en HubSpot: análisis de riesgo y contratos.
 *
 * Plan:   C:\Temp\Plan_Asignacion_Equilibrada_Analisis_Riesgo.md (v4)
 * Anexo:  C:\Temp\Plan_Asignacion_Equilibrada_Analisis_Riesgo_detalle.md (datos y simulaciones)
 *
 * Qué hace: de 7:30 a 4:30 reparte los registros que esperan responsable en dos flujos. Cada flujo tiene su
 * equipo, sus parámetros y sus saldos (ver FLUJOS):
 *   analisis_riesgo  objeto "Análisis de riesgo": de "Asignación de analista" (sin propietario) a
 *                    "Analista asignado y en trámite", entre analistas y coordinadoras.
 *   contratos        objeto "Contratos": de "Asignacion de analista" (traiga o no propietario) a
 *                    "Consolidacion de informacion", entre los ejecutivos.
 * Elige con una regla greedy de costo marginal (casos y canon de arrendamiento, con un techo duro de canon por
 * persona), pone a la persona como propietaria y mueve el registro de etapa. Solo escribe en HubSpot.
 *
 * Uso (Node 24, sin dependencias):
 *   node asignacion_equilibrada.ts                  ciclo continuo cada 2 min en MODO SOMBRA (decide y registra, no escribe)
 *   node asignacion_equilibrada.ts --activar        igual, pero escribe en HubSpot
 *   node asignacion_equilibrada.ts --una-vez        un solo ciclo y termina (para n8n o el Programador de tareas). Fuera de
 *                                                   horario, en pausa o con otra ejecución en curso sale con 0 sin tocar HubSpot
 *   node asignacion_equilibrada.ts --diagnostico    revisa token, scopes, objetos, etapas, propiedades y propietarios
 *   node asignacion_equilibrada.ts --parametros     recalcula data/<flujo>/parametros.json desde AGSSA (--desde y --hasta opcionales)
 *   node asignacion_equilibrada.ts --autoprueba     pruebas del motor (no toca HubSpot ni AGSSA)
 *   Extras: --flujo analisis_riesgo|contratos (solo ese flujo; por defecto, los dos), --produccion (usa HUBSPOT_TOKEN
 *   en vez de HUBSPOT_TOKEN_SANDBOX) y --ignorar-horario (pruebas).
 *
 * Archivos (junto a este script):
 *   .env                           HUBSPOT_TOKEN_SANDBOX y HUBSPOT_TOKEN
 *   data/<flujo>/nomina.json       persona ↔ documento AGSSA ↔ propietario de HubSpot ↔ rol
 *   data/<flujo>/parametros.json   techos, pesos por rol y canon típico (se genera con --parametros)
 *   data/<flujo>/PAUSA             si existe, ese flujo no asigna nada
 *   data/ausencias.json            días laborales, festivos y ausencias de los dos equipos (lo mantiene coordinación)
 *   data/PAUSA                     si existe, no se asigna nada en ningún flujo (interruptor de apagado)
 *   logs/decisiones.jsonl          una línea por decisión, alerta u omisión, con su flujo
 *   logs/revertidas.jsonl          lo que deshizo revertir_asignacion.ts (fase de pruebas)
 *
 * En HubSpot, cada objeto necesita dos propiedades que crea una persona (el plan no pide scopes de escritura de esquema):
 *   fecha_asignacion_analista   tipo "Fecha y hora"
 *   asignacion_detalle          tipo "Texto de varias líneas"
 * Scopes de la app privada: crm.objects.custom.read, crm.objects.custom.write,
 *   crm.schemas.custom.read y crm.objects.owners.read.
 *
 * Variables opcionales para fijar lo que el diagnóstico descubre solo por nombre (FLUJO = ANALISIS_RIESGO o CONTRATOS):
 *   HUBSPOT_<FLUJO>_OBJETO, HUBSPOT_<FLUJO>_PIPELINE, HUBSPOT_<FLUJO>_ETAPA_COLA, HUBSPOT_<FLUJO>_ETAPA_DESTINO
 *   y HUBSPOT_<FLUJO>_PROP_CANON.
 *
 * Modo sombra: decide exactamente como si escribiera, pero solo anota. Como no saca los registros de la cola, no
 * vuelve a decidir uno que ya decidió dentro de la ventana de los saldos. Para que sus decisiones sigan su propio
 * reparto (y no el manual), sus saldos se reconstruyen con sus decisiones anteriores del log. En modo activo los
 * saldos salen solo de HubSpot.
 *
 * Reversión (fase de pruebas): en modo activo, cada decisión guarda en el log lo que el registro tenía antes de
 * escribirlo. Con eso, node revertir_asignacion.ts lo devuelve a como estaba (ver ese archivo).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

// ═════════════════════════════════════════════════════════════════════════════
// 1. CONSTANTES (los valores del plan; no se configuran a propósito)
// ═════════════════════════════════════════════════════════════════════════════

const DIR = import.meta.dirname;
export const RUTA = {
  env: join(DIR, ".env"),
  datos: join(DIR, "data"),
  ausencias: join(DIR, "data", "ausencias.json"),
  pausa: join(DIR, "data", "PAUSA"),
  log: join(DIR, "logs", "decisiones.jsonl"),
  candado: join(DIR, "logs", "asignacion.lock"),
};

const OFFSET_BOGOTA_MS = -5 * 3_600_000; // Colombia no tiene horario de verano
const INICIO_MIN = 7 * 60 + 30; // 7:30, en minutos desde la medianoche
const FIN_MIN = 16 * 60 + 30; // 4:30 p. m.
const INTERVALO_MS = 2 * 60_000; // un ciclo cada 2 minutos
const MEMORIA = 0.9; // δ: cada día hábil los saldos se multiplican por 0,9
const VENTANA_DIAS_HABILES = 30; // historial con el que se reconstruyen los saldos
const MAX_COLA_ACTIVA = 200; // seguro: una cola mayor en modo activo se revisa antes de escribir
const MAX_MIN_OCUPADO = 10; // con --una-vez, un candado más viejo que esto ya no es "el disparo anterior que sigue escribiendo"
const GRACIA_INDICE_MS = 15 * 60_000; // la búsqueda de HubSpot puede tardar en ver una escritura reciente
const PAUSA_ENTRE_LLAMADAS_MS = 220; // la búsqueda de HubSpot admite ~5 llamadas por segundo
const EDAD_MAX_PARAMETROS_DIAS = 100; // se recalculan cada trimestre
const MIN_CASOS_POR_PERSONA = 100; // mínimo para que un P99 tenga sentido
const EPS = 1e-9;
const VERSION_MOTOR = "v1";
const ESCRITURA_SOMBRA = "sombra";
/** Lo que el modo activo escribe en cada registro. Lo que tenía antes queda en el log, para revertir_asignacion.ts. */
export const PROPIEDADES_ESCRITAS = ["hubspot_owner_id", "hs_pipeline_stage", "fecha_asignacion_analista", "asignacion_detalle"] as const;

// ═════════════════════════════════════════════════════════════════════════════
// 2. TIPOS Y FLUJOS
// ═════════════════════════════════════════════════════════════════════════════

/** Rol dentro del equipo de un flujo: "analista" y "coordinador" en análisis de riesgo, "ejecutivo" en contratos. */
export type Rol = string;
export type Modo = "sombra" | "activo";
export type Entorno = "sandbox" | "produccion";

export interface Persona {
  /** Identificador corto y estable (minúsculas, números y guion bajo). */
  clave: string;
  /** Cómo se ve en consola, logs y asignacion_detalle. */
  etiqueta: string;
  /** Nombre completo; sirve para cruzar con los propietarios de HubSpot. */
  nombre: string;
  rol: Rol;
  /** T_Usuarios.Documento: el T_Analisis.UsuAnalista o el T_Contratos.UsuEjecutivo de AGSSA. */
  documento: string;
  /** hubspot_owner_id. Si es null se busca por correo o por nombre. */
  ownerId: string | null;
  correo: string | null;
  activo: boolean;
}

export interface Parametros {
  generado: string;
  calibradoCon: { desde: string; hasta: string; casos: number };
  /** m̄: canon típico, en pesos. */
  canonTipico: number;
  /** c = capacidad en casos y s = cuota de canon, por rol. */
  roles: Record<Rol, { c: number; s: number }>;
  /** T_j: techo duro de canon por persona (P99 de lo que ha manejado), en pesos. */
  techos: Record<string, number>;
}

export interface Ausencia {
  /** Clave de la persona (en cualquiera de las nóminas), o "*" para todos (festivos). */
  persona: string;
  desde: string;
  hasta: string;
  motivo?: string;
}

export interface Calendario {
  /** 0 = domingo, 1 = lunes … 6 = sábado. */
  diasLaborales: number[];
  ausencias: Ausencia[];
}

/** e_j: casos recibidos menos los que le correspondían. E_j: canon recibido menos el que le correspondía (en cánones típicos). */
export interface Estado {
  e: Record<string, number>;
  E: Record<string, number>;
}

export interface Evento {
  id: string;
  instante: number;
  clave: string;
  canon: number | null;
}

export interface Candidato {
  clave: string;
  delta: number;
  e: number;
  E: number;
}

export interface Decision {
  elegido: string;
  candidatos: Candidato[];
  w: number;
  sinCanon: boolean;
  respaldo: boolean;
}

export interface CasoHistorico {
  id: string;
  dia: string;
  clave: string;
  canon: number;
}

export interface RegistroHS {
  id: string;
  properties: Record<string, string | null | undefined>;
}

interface PaginaHS {
  results: RegistroHS[];
  paging?: { next?: { after: string } };
}

export interface ClienteHS {
  solicitar<T>(metodo: "GET" | "POST" | "PATCH", ruta: string, cuerpo?: unknown): Promise<T>;
}

/** Lo que cambia entre un flujo y otro. Todo lo demás (regla, horario, seguridad) es común. */
export interface Flujo {
  /** Carpeta data/<clave>/, valor de --flujo y campo "flujo" del log. */
  clave: string;
  nombre: string;
  /** Cómo se llama a quien recibe los casos, en singular y plural (para los mensajes). */
  persona: string;
  personas: string;
  /** Si una etiqueta del objeto (ya normalizada) es la de este flujo. */
  esObjeto: (etiqueta: string) => boolean;
  /** Etapas de origen (la cola) y de destino, como se llaman en HubSpot (se comparan sin tildes ni mayúsculas). */
  etapas: { cola: string; destino: string };
  /** true: la cola son solo los registros sin propietario. false: el propietario que traiga se reemplaza. */
  colaSinPropietario: boolean;
  /** Roles válidos en la nómina del flujo. */
  roles: Rol[];
  /** Consultas a AGSSA para --parametros (cada caso: id, fecha de asignación, documento de quien lo recibió y canon). */
  agssa: { ultimaFecha: string; casos: (documentos: string, desde: string, hasta: string) => string };
}

export const FLUJOS: readonly Flujo[] = [
  {
    clave: "analisis_riesgo",
    nombre: "Análisis de riesgo",
    persona: "analista",
    personas: "analistas",
    esObjeto: (etiqueta) => etiqueta.includes("analisis de riesgo"),
    etapas: { cola: "Asignación de analista", destino: "Analista asignado y en trámite" },
    colaSinPropietario: true,
    roles: ["analista", "coordinador"],
    agssa: {
      ultimaFecha: "SELECT CONVERT(varchar(10), MAX(FechaAsignacionAnalisis), 120) FROM T_Analisis",
      casos: (documentos, desde, hasta) =>
        "SELECT a.IdAnalisis, CONVERT(varchar(19), a.FechaAsignacionAnalisis, 126), a.UsuAnalista, CONVERT(varchar(30), CAST(i.CanonArrendamiento AS decimal(18,2))) " +
        "FROM T_Analisis a JOIN T_Solicitudes s ON s.IdAnalisis = a.IdAnalisis LEFT JOIN T_Inmueble i ON i.IdInmueble = s.IdInmueble " +
        `WHERE a.UsuAnalista IN (${documentos}) AND a.FechaAsignacionAnalisis >= '${desde}' AND a.FechaAsignacionAnalisis < '${hasta}' ORDER BY a.FechaAsignacionAnalisis`,
    },
  },
  {
    clave: "contratos",
    nombre: "Contratos",
    persona: "ejecutivo",
    personas: "ejecutivos",
    // Exacto: "Orden de contrato" u otro objeto que solo mencione contratos no es este.
    esObjeto: (etiqueta) => etiqueta === "contrato" || etiqueta === "contratos",
    etapas: { cola: "Asignacion de analista", destino: "Consolidacion de informacion" },
    colaSinPropietario: false,
    roles: ["ejecutivo"],
    agssa: {
      ultimaFecha: "SELECT CONVERT(varchar(10), MAX(FechaAsignacionContrato), 120) FROM T_Contratos",
      casos: (documentos, desde, hasta) =>
        "SELECT c.IdContrato, CONVERT(varchar(19), c.FechaAsignacionContrato, 126), c.UsuEjecutivo, CONVERT(varchar(30), CAST(c.Canon AS decimal(18,2))) " +
        `FROM T_Contratos c WHERE c.UsuEjecutivo IN (${documentos}) AND c.FechaAsignacionContrato >= '${desde}' AND c.FechaAsignacionContrato < '${hasta}' ORDER BY c.FechaAsignacionContrato`,
    },
  },
];

const rutaFlujo = (flujo: Flujo, archivo: string) => join(RUTA.datos, flujo.clave, archivo);

export interface ConfigHS {
  objeto: string;
  pipeline: string;
  etapaCola: string;
  etapaDestino: string;
  propCanon: string;
  /** ownerId de HubSpot → clave de la nómina. */
  claveDeOwner: Map<string, string>;
  /** clave de la nómina → ownerId de HubSpot. */
  ownerDeClave: Map<string, string>;
}

export interface Contexto {
  flujo: Flujo;
  modo: Modo;
  entorno: Entorno;
  hs: ClienteHS;
  cfg: ConfigHS;
  pool: Persona[];
  params: Parametros;
  /** Si no viene, se lee data/ausencias.json en cada ciclo (coordinación lo edita durante el día). */
  calendario?: Calendario;
  ignorarHorario?: boolean;
}

export interface ResumenCiclo {
  omitido?: string;
  cola: number;
  decididos: number;
  escritos: number;
  omitidos: number;
}

interface DecisionLog {
  tipo: string;
  fecha: string;
  flujo: string;
  modo: Modo;
  entorno: Entorno;
  id: string;
  canon: number | null;
  elegido: string;
  escritura: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. UTILIDADES
// ═════════════════════════════════════════════════════════════════════════════

/** Error de configuración o de uso: se muestra el mensaje, sin traza. */
export class ErrorUso extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorUso";
  }
}

/** El candado lo tiene otro proceso vivo: se sabe cuál y desde hace cuántos minutos. */
export class ErrorOcupado extends ErrorUso {
  pid: number;
  minutos: number;
  constructor(pid: number, minutos: number) {
    super(`Ya hay otra instancia en ejecución (PID ${pid}, desde hace ${minutos} min). Si no es cierto, hay que borrar ${RUTA.candado}.`);
    this.name = "ErrorOcupado";
    this.pid = pid;
    this.minutos = minutos;
  }
}

export class ErrorHubSpot extends Error {
  status: number;
  constructor(status: number, mensaje: string) {
    super(mensaje);
    this.name = "ErrorHubSpot";
    this.status = status;
  }
}

const dormir = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));
const mensajeDe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const promedio = (valores: number[]) => valores.reduce((suma, x) => suma + x, 0) / valores.length;
const redondear = (n: number, decimales: number) => Math.round(n * 10 ** decimales) / 10 ** decimales;
const cop = (n: number) => Math.round(n).toLocaleString("es-CO");

/** Cuantil con interpolación lineal (el mismo de las simulaciones del plan). */
export function cuantil(valores: number[], p: number): number {
  const orden = [...valores].sort((x, y) => x - y);
  const i = (orden.length - 1) * p;
  const abajo = Math.floor(i);
  return orden[abajo] + (orden[Math.ceil(i)] - orden[abajo]) * (i - abajo);
}

/** Minúsculas, sin tildes ni signos: para comparar nombres y etiquetas. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Canon válido (> 0) o null. Un canon vacío o ilegible se trata como "sin canon". */
export function parsearCanon(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Fecha de HubSpot (ISO o milisegundos como texto) a milisegundos. */
export function parsearInstante(valor: unknown): number | null {
  if (typeof valor !== "string" || valor === "") return null;
  const ms = /^\d+$/.test(valor) ? Number(valor) : Date.parse(valor);
  return Number.isFinite(ms) ? ms : null;
}

// ── Tiempo en hora de Colombia ────────────────────────────────────────────────

export const fechaBogota = (ms: number): string => new Date(ms + OFFSET_BOGOTA_MS).toISOString().slice(0, 10);
export const minutosBogota = (ms: number): number => {
  const d = new Date(ms + OFFSET_BOGOTA_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const horaLocal = (ms: number): string => new Date(ms + OFFSET_BOGOTA_MS).toISOString().slice(0, 16).replace("T", " ");
export const diaSemana = (fecha: string): number => new Date(`${fecha}T00:00:00Z`).getUTCDay();
export function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const dentroDeHorario = (ms: number): boolean => {
  const m = minutosBogota(ms);
  return m >= INICIO_MIN && m <= FIN_MIN;
};

// ── Calendario y presencia ────────────────────────────────────────────────────

const cubre = (a: Ausencia, fecha: string) => a.desde <= fecha && fecha <= a.hasta;

export const estaAusente = (clave: string, fecha: string, cal: Calendario): boolean =>
  cal.ausencias.some((a) => (a.persona === clave || a.persona === "*") && cubre(a, fecha));

/** Día laboral = día de la semana laboral y sin una ausencia de "*" (festivo). */
export const esDiaLaboral = (fecha: string, cal: Calendario): boolean =>
  cal.diasLaborales.includes(diaSemana(fecha)) && !cal.ausencias.some((a) => a.persona === "*" && cubre(a, fecha));

/** Quiénes compiten ese día: la nómina activa sin los ausentes. Un día no laboral no tiene presentes. */
export function presentesEn(fecha: string, pool: Persona[], cal: Calendario, ignorarDiaLaboral = false): Persona[] {
  if (!ignorarDiaLaboral && !esDiaLaboral(fecha, cal)) return [];
  return pool.filter((a) => !estaAusente(a.clave, fecha, cal));
}

/** Primer día del historial con el que se reconstruyen los saldos (N días hábiles antes de hoy). */
export function inicioVentana(hoy: string, cal: Calendario, dias: number = VENTANA_DIAS_HABILES): string {
  let fecha = hoy;
  for (let restantes = dias, guarda = 0; restantes > 0 && guarda < 400; guarda++) {
    fecha = sumarDias(fecha, -1);
    if (esDiaLaboral(fecha, cal)) restantes--;
  }
  return fecha;
}

// ── Registro de decisiones y alertas ──────────────────────────────────────────

function registrar(linea: Record<string, unknown>, instante: number = Date.now()): void {
  mkdirSync(dirname(RUTA.log), { recursive: true });
  appendFileSync(RUTA.log, JSON.stringify({ fecha: new Date(instante).toISOString(), ...linea }) + "\n");
}

/** Una alerta va a la consola y al log; el plan no define otro canal. */
function alerta(flujo: Flujo | null, tipo: string, detalle: string, extra: Record<string, unknown> = {}): void {
  console.error(`[ALERTA] ${flujo ? `${flujo.nombre} · ` : ""}${tipo}: ${detalle}`);
  registrar({ tipo: "alerta", ...(flujo ? { flujo: flujo.clave } : {}), alerta: tipo, detalle, ...extra });
}

function leerDecisiones(desdeMs: number): DecisionLog[] {
  if (!existsSync(RUTA.log)) return [];
  const salida: DecisionLog[] = [];
  for (const linea of readFileSync(RUTA.log, "utf8").split("\n")) {
    if (!linea) continue;
    try {
      const d = JSON.parse(linea) as DecisionLog;
      if (d.tipo === "decision" && Date.parse(d.fecha) >= desdeMs) salida.push(d);
    } catch {
      // Línea dañada (p. ej. corte de energía a mitad de escritura): se ignora.
    }
  }
  return salida;
}

/** Las decisiones de este flujo, en este modo y este entorno, desde `desdeMs`. */
function decisionesDelFlujo(ctx: Pick<Contexto, "flujo" | "modo" | "entorno">, desdeMs: number): DecisionLog[] {
  return leerDecisiones(desdeMs).filter((d) => d.flujo === ctx.flujo.clave && d.modo === ctx.modo && d.entorno === ctx.entorno);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. MOTOR (funciones puras: reciben el estado y lo actualizan, sin leer ni escribir nada)
// ═════════════════════════════════════════════════════════════════════════════

export function estadoVacio(claves: string[]): Estado {
  return {
    e: Object.fromEntries(claves.map((k) => [k, 0])),
    E: Object.fromEntries(claves.map((k) => [k, 0])),
  };
}

/** Al empezar cada día hábil los desbalances viejos se olvidan un poco. */
export function aplicarMemoria(estado: Estado, factor: number = MEMORIA): void {
  for (const k of Object.keys(estado.e)) {
    estado.e[k] *= factor;
    estado.E[k] *= factor;
  }
}

/** w: el caso en cánones típicos. Sin canon cuenta como un caso típico (w = 1). */
export const pesoDeCaso = (canon: number | null, p: Parametros): number => (canon ?? p.canonTipico) / p.canonTipico;

/** Paso 1: la llegada de un caso sube la meta de todos los presentes en proporción a su capacidad. */
export function subirMeta(estado: Estado, presentes: Persona[], w: number, p: Parametros): void {
  let sumaC = 0;
  let sumaS = 0;
  for (const a of presentes) {
    sumaC += p.roles[a.rol].c;
    sumaS += p.roles[a.rol].s;
  }
  for (const a of presentes) {
    estado.e[a.clave] -= p.roles[a.rol].c / sumaC;
    estado.E[a.clave] -= (w * p.roles[a.rol].s) / sumaS;
  }
}

export function registrarAsignacion(estado: Estado, clave: string, w: number): void {
  estado.e[clave] += 1;
  estado.E[clave] += w;
}

/** Paso 3: Δ_j = (2·e_j + 1)/c_j + (2·E_j·w + w²)/s_j  (costo marginal cuadrático). */
export function costoMarginal(estado: Estado, a: Persona, w: number, p: Parametros): number {
  const { c, s } = p.roles[a.rol];
  return (2 * estado.e[a.clave] + 1) / c + (2 * estado.E[a.clave] * w + w * w) / s;
}

/**
 * Reparte un caso entre los presentes y actualiza el estado (pasos 1 a 4 del plan).
 * `presentes` debe venir en el orden de la nómina: es el último criterio de desempate.
 */
export function asignarCaso(estado: Estado, presentes: Persona[], canon: number | null, p: Parametros): Decision {
  if (!presentes.length) throw new Error("asignarCaso: no hay nadie presente");
  const sinCanon = canon === null;
  const m = canon ?? p.canonTipico;
  const w = m / p.canonTipico;

  subirMeta(estado, presentes, w, p);

  // Paso 2: solo compiten los que tienen techo para este canon; si nadie lo tiene, el más experimentado.
  let elegibles = presentes.filter((a) => m <= p.techos[a.clave]);
  const respaldo = elegibles.length === 0;
  if (respaldo) {
    elegibles = [presentes.reduce((mejor, a) => (p.techos[a.clave] > p.techos[mejor.clave] ? a : mejor))];
  }

  const candidatos: Candidato[] = elegibles.map((a) => ({
    clave: a.clave,
    delta: costoMarginal(estado, a, w, p),
    e: estado.e[a.clave],
    E: estado.E[a.clave],
  }));

  // Paso 4: gana el menor Δ; en empate, el de menor e_j; luego el orden de la nómina.
  let elegido = candidatos[0];
  for (const c of candidatos.slice(1)) {
    const diferencia = c.delta - elegido.delta;
    if (diferencia < -EPS || (Math.abs(diferencia) <= EPS && c.e < elegido.e - EPS)) elegido = c;
  }

  registrarAsignacion(estado, elegido.clave, w);
  return { elegido: elegido.clave, candidatos, w, sinCanon, respaldo };
}

/**
 * Reconstruye e_j y E_j repitiendo, día a día, lo que hizo el reparto: la memoria al empezar
 * cada día hábil y, por cada asignación, la subida de meta de los presentes más el caso recibido.
 * Los presentes de un día son la nómina menos los ausentes, más quien haya recibido casos ese día.
 */
export function reconstruirEstado(eventos: Evento[], hoy: string, pool: Persona[], cal: Calendario, p: Parametros): Estado {
  const estado = estadoVacio(pool.map((a) => a.clave));
  const claves = new Set(pool.map((a) => a.clave));
  const validos = eventos
    .filter((ev) => claves.has(ev.clave) && fechaBogota(ev.instante) <= hoy)
    .sort((x, y) => x.instante - y.instante || x.id.localeCompare(y.id, "en", { numeric: true }));
  if (!validos.length) return estado;

  const porDia = new Map<string, Evento[]>();
  for (const ev of validos) {
    const dia = fechaBogota(ev.instante);
    const lista = porDia.get(dia);
    if (lista) lista.push(ev);
    else porDia.set(dia, [ev]);
  }

  for (let dia = fechaBogota(validos[0].instante); dia <= hoy; dia = sumarDias(dia, 1)) {
    const delDia = porDia.get(dia) ?? [];
    if (!esDiaLaboral(dia, cal) && !delDia.length) continue;
    aplicarMemoria(estado);
    if (!delDia.length) continue;

    const recibieron = new Set(delDia.map((ev) => ev.clave));
    const base = new Set(presentesEn(dia, pool, cal).map((a) => a.clave));
    const presentes = pool.filter((a) => base.has(a.clave) || recibieron.has(a.clave));
    for (const ev of delDia) {
      const w = pesoDeCaso(ev.canon, p);
      subirMeta(estado, presentes, w, p);
      registrarAsignacion(estado, ev.clave, w);
    }
  }
  return estado;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. DATOS LOCALES (nómina, parámetros, ausencias)
// ═════════════════════════════════════════════════════════════════════════════

function leerJSON<T>(ruta: string, descripcion: string): T {
  let texto: string;
  try {
    texto = readFileSync(ruta, "utf8");
  } catch {
    throw new ErrorUso(`No se encontró el archivo de ${descripcion}: ${ruta}`);
  }
  try {
    return JSON.parse(texto) as T;
  } catch (error) {
    throw new ErrorUso(`El archivo de ${descripcion} no es un JSON válido (${mensajeDe(error)}): ${ruta}`);
  }
}

/** Valida una nómina ya leída. `origen` es el archivo, para los mensajes. */
export function validarNomina(bruto: { personas?: Partial<Persona>[] }, flujo: Flujo, origen: string): { todos: Persona[]; pool: Persona[] } {
  if (!Array.isArray(bruto.personas) || !bruto.personas.length) throw new ErrorUso(`${origen} debe tener una lista 'personas'.`);
  const vistas = new Set<string>();
  const todos = bruto.personas.map((a, i): Persona => {
    const donde = `${origen}, personas[${i}]`;
    if (!a.clave || !/^[a-z0-9_]+$/.test(a.clave)) throw new ErrorUso(`${donde}: 'clave' debe ser minúsculas, números y guion bajo.`);
    if (vistas.has(a.clave)) throw new ErrorUso(`${donde}: la clave '${a.clave}' está repetida.`);
    vistas.add(a.clave);
    if (!a.rol || !flujo.roles.includes(a.rol)) throw new ErrorUso(`${donde}: 'rol' debe ser ${flujo.roles.map((r) => `"${r}"`).join(" o ")}.`);
    if (!a.nombre) throw new ErrorUso(`${donde}: falta 'nombre'.`);
    if (!a.documento) throw new ErrorUso(`${donde}: falta 'documento'.`);
    return {
      clave: a.clave,
      etiqueta: a.etiqueta ?? a.nombre,
      nombre: a.nombre,
      rol: a.rol,
      documento: String(a.documento),
      ownerId: a.ownerId ? String(a.ownerId) : null,
      correo: a.correo ?? null,
      activo: a.activo !== false,
    };
  });
  const pool = todos.filter((a) => a.activo);
  if (!pool.length) throw new ErrorUso(`${origen}: no hay ${flujo.personas} activos.`);
  return { todos, pool };
}

export function cargarNomina(flujo: Flujo): { todos: Persona[]; pool: Persona[] } {
  const origen = `data/${flujo.clave}/nomina.json`;
  return validarNomina(leerJSON(rutaFlujo(flujo, "nomina.json"), `la nómina de ${flujo.nombre} (${origen})`), flujo, origen);
}

export function cargarParametros(flujo: Flujo, pool: Persona[]): Parametros {
  const origen = `data/${flujo.clave}/parametros.json`;
  const p = leerJSON<Parametros>(
    rutaFlujo(flujo, "parametros.json"),
    `los parámetros de ${flujo.nombre} (${origen}); se generan con: node asignacion_equilibrada.ts --parametros --flujo ${flujo.clave}`,
  );
  const positivo = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!positivo(p.canonTipico)) throw new ErrorUso(`${origen}: 'canonTipico' debe ser un número mayor que 0.`);
  for (const rol of new Set(pool.map((a) => a.rol))) {
    if (!positivo(p.roles?.[rol]?.c) || !positivo(p.roles?.[rol]?.s)) {
      throw new ErrorUso(`${origen}: faltan los pesos 'c' y 's' del rol ${rol}.`);
    }
  }
  for (const a of pool) {
    if (!positivo(p.techos?.[a.clave])) {
      throw new ErrorUso(`${origen} no tiene techo para ${a.etiqueta} (${a.clave}); hay que ejecutar --parametros --flujo ${flujo.clave}.`);
    }
  }
  return p;
}

export function cargarCalendario(ruta: string = RUTA.ausencias): Calendario {
  if (!existsSync(ruta)) return { diasLaborales: [1, 2, 3, 4, 5], ausencias: [] };
  const bruto = leerJSON<Partial<Calendario>>(ruta, "las ausencias (data/ausencias.json)");
  const dias = bruto.diasLaborales ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(dias) || dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ErrorUso("data/ausencias.json: 'diasLaborales' debe ser una lista de números de 0 (domingo) a 6 (sábado).");
  }
  const formatoFecha = /^\d{4}-\d{2}-\d{2}$/;
  const ausencias = (bruto.ausencias ?? []).map((a, i): Ausencia => {
    const donde = `data/ausencias.json, ausencias[${i}]`;
    if (!a.persona) throw new ErrorUso(`${donde}: falta 'persona' (su clave de la nómina, o "*" para todos).`);
    if (!formatoFecha.test(a.desde ?? "") || !formatoFecha.test(a.hasta ?? "")) throw new ErrorUso(`${donde}: 'desde' y 'hasta' deben ser AAAA-MM-DD.`);
    if (a.desde > a.hasta) throw new ErrorUso(`${donde}: 'desde' es posterior a 'hasta'.`);
    return { persona: a.persona, desde: a.desde, hasta: a.hasta, motivo: a.motivo };
  });
  return { diasLaborales: dias, ausencias };
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. CLIENTE DE HUBSPOT
// ═════════════════════════════════════════════════════════════════════════════

export function cargarEnv(): void {
  try {
    process.loadEnvFile(RUTA.env);
  } catch {
    // Sin .env se usan las variables del proceso.
  }
}

export function elegirEntorno(produccion: boolean): { entorno: Entorno; token: string } {
  const variable = produccion ? "HUBSPOT_TOKEN" : "HUBSPOT_TOKEN_SANDBOX";
  const token = process.env[variable];
  if (!token) throw new ErrorUso(`Falta ${variable} en el archivo .env o en las variables de entorno.`);
  return { entorno: produccion ? "produccion" : "sandbox", token };
}

/** HubSpot, o localhost para pruebas: así una variable de entorno mal puesta no manda el token a otro sitio. */
export function urlBase(): string {
  const url = (process.env.HUBSPOT_API_URL ?? "https://api.hubapi.com").replace(/\/+$/, "");
  if (url !== "https://api.hubapi.com" && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    throw new ErrorUso("HUBSPOT_API_URL solo puede apuntar a https://api.hubapi.com o a localhost (pruebas).");
  }
  return url;
}

/** Cliente con reintentos ante 429, errores 5xx y fallas de red, y una pausa mínima entre llamadas. */
export function crearCliente(token: string, base: string): ClienteHS {
  let ultimaLlamada = 0;
  return {
    async solicitar<T>(metodo: "GET" | "POST" | "PATCH", ruta: string, cuerpo?: unknown): Promise<T> {
      const MAX_INTENTOS = 5;
      for (let intento = 1; ; intento++) {
        const espera = ultimaLlamada + PAUSA_ENTRE_LLAMADAS_MS - Date.now();
        if (espera > 0) await dormir(espera);
        ultimaLlamada = Date.now();

        let respuesta: Response;
        try {
          respuesta = await fetch(base + ruta, {
            method: metodo,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          if (intento === MAX_INTENTOS) throw new ErrorHubSpot(0, `Sin respuesta de HubSpot en ${metodo} ${ruta}: ${mensajeDe(error)}`);
          await dormir(1000 * intento);
          continue;
        }

        if (respuesta.ok) return (respuesta.status === 204 ? undefined : await respuesta.json()) as T;

        const texto = await respuesta.text();
        const reintentable = respuesta.status === 429 || respuesta.status >= 500;
        if (!reintentable || intento === MAX_INTENTOS) {
          throw new ErrorHubSpot(respuesta.status, `HubSpot respondió ${respuesta.status} en ${metodo} ${ruta}: ${texto.slice(0, 600)}`);
        }
        const segundos = Number(respuesta.headers.get("retry-after"));
        await dormir(segundos > 0 ? segundos * 1000 : 1000 * intento);
      }
    },
  };
}

/** Todas las páginas de una búsqueda. La API corta en 10.000 resultados; antes de eso se avisa. */
async function buscarTodo(hs: ClienteHS, objeto: string, cuerpo: Record<string, unknown>): Promise<RegistroHS[]> {
  const todos: RegistroHS[] = [];
  let after: string | undefined;
  do {
    const pagina = await hs.solicitar<PaginaHS>("POST", `/crm/v3/objects/${objeto}/search`, {
      ...cuerpo,
      limit: 100,
      ...(after ? { after } : {}),
    });
    todos.push(...pagina.results);
    after = pagina.paging?.next?.after;
    if (after && todos.length >= 9_500) {
      alerta(null, "busqueda_truncada", `La búsqueda en ${objeto} superó ${todos.length} registros; HubSpot no entrega más de 10.000. Se usa lo leído.`);
      break;
    }
  } while (after);
  return todos;
}

/** Filtros de la cola: la etapa de origen del flujo y, si el flujo lo pide, que el registro no tenga propietario. */
export function filtrosCola(flujo: Flujo, cfg: Pick<ConfigHS, "pipeline" | "etapaCola">): { filters: Record<string, string>[] }[] {
  const filters: Record<string, string>[] = [
    { propertyName: "hs_pipeline", operator: "EQ", value: cfg.pipeline },
    { propertyName: "hs_pipeline_stage", operator: "EQ", value: cfg.etapaCola },
  ];
  if (flujo.colaSinPropietario) filters.push({ propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" });
  return [{ filters }];
}

/** La cola: registros en la etapa de origen del flujo (en análisis de riesgo, además, sin propietario). */
function leerCola(ctx: Contexto): Promise<RegistroHS[]> {
  const { cfg } = ctx;
  return buscarTodo(ctx.hs, cfg.objeto, {
    filterGroups: filtrosCola(ctx.flujo, cfg),
    properties: [cfg.propCanon, "hs_pipeline_stage", "hubspot_owner_id"],
  });
}

/** Consulta del historial: registros con fecha_asignacion_analista desde `desdeMs`. Orden fijo por ID para paginar sin saltos. */
function cuerpoHistorial(propCanon: string, desdeMs: number): Record<string, unknown> {
  return {
    filterGroups: [{ filters: [{ propertyName: "fecha_asignacion_analista", operator: "GTE", value: String(desdeMs) }] }],
    properties: ["hubspot_owner_id", "fecha_asignacion_analista", propCanon],
    sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
  };
}

/**
 * Asignaciones de los últimos ~30 días hábiles. Salen de HubSpot (propietario actual y
 * fecha_asignacion_analista), así que una reasignación manual se ve en el siguiente ciclo.
 * Del log se agregan: en modo sombra, sus decisiones anteriores; en modo activo, solo las
 * escrituras de los últimos minutos que la búsqueda de HubSpot todavía no devuelve.
 */
async function leerHistorial(ctx: Contexto, ahora: number, desdeMs: number): Promise<Evento[]> {
  const { cfg } = ctx;
  const registros = await buscarTodo(ctx.hs, cfg.objeto, cuerpoHistorial(cfg.propCanon, desdeMs));

  const eventos: Evento[] = [];
  for (const r of registros) {
    const ownerId = r.properties.hubspot_owner_id;
    const instante = parsearInstante(r.properties.fecha_asignacion_analista);
    const clave = ownerId ? cfg.claveDeOwner.get(ownerId) : undefined;
    if (!clave || instante === null) continue;
    eventos.push({ id: r.id, instante, clave, canon: parsearCanon(r.properties[cfg.propCanon]) });
  }

  const vistos = new Set(eventos.map((ev) => ev.id));
  for (const d of decisionesDelFlujo(ctx, desdeMs)) {
    if (vistos.has(d.id)) continue;
    const instante = Date.parse(d.fecha);
    const valida =
      ctx.modo === "sombra" ? d.escritura === ESCRITURA_SOMBRA : d.escritura === "ok" && ahora - instante <= GRACIA_INDICE_MS;
    if (!valida) continue;
    vistos.add(d.id);
    eventos.push({ id: d.id, instante, clave: d.elegido, canon: d.canon });
  }
  return eventos;
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. DIAGNÓSTICO (token, scopes, objeto, etapas, propiedades y propietarios)
// ═════════════════════════════════════════════════════════════════════════════

interface SchemaHS {
  objectTypeId: string;
  name?: string;
  labels?: { singular?: string; plural?: string };
}
interface PipelineHS {
  id: string;
  label: string;
  stages: { id: string; label: string }[];
}
interface PropiedadHS {
  name: string;
  label: string;
  type: string;
}
interface PropietarioHS {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}
interface Paso {
  estado: "ok" | "aviso" | "error";
  texto: string;
}

const MARCA = { ok: "[OK]    ", aviso: "[AVISO] ", error: "[ERROR] " } as const;

/** Variable de entorno de un flujo, p. ej. HUBSPOT_CONTRATOS_PROP_CANON. */
const variableDe = (flujo: Flujo, nombre: string): string => `HUBSPOT_${flujo.clave.toUpperCase()}_${nombre}`;
const valorDe = (flujo: Flujo, nombre: string): string => process.env[variableDe(flujo, nombre)] ?? "";

/** El nombre de HubSpot (nombre y apellido) debe estar contenido en el de la nómina, o al revés. */
export function coincideNombre(completo: string, otro: string): boolean {
  const A = new Set(normalizar(completo).split(" ").filter(Boolean));
  const B = new Set(normalizar(otro).split(" ").filter(Boolean));
  if (A.size < 2 || B.size < 2) return false;
  const contenido = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
  return contenido(B, A) || contenido(A, B);
}

/**
 * La propiedad del canon: entre las que dicen "canon" en su nombre o etiqueta, las numéricas; si queda más de
 * una, la que se llama exactamente "Canon" o "Canon de arrendamiento". Si no queda una sola, no adivina.
 */
export function elegirPropCanon(propiedades: PropiedadHS[]): { elegida: PropiedadHS | null; candidatas: PropiedadHS[] } {
  const conCanon = propiedades.filter((p) => normalizar(`${p.label} ${p.name}`).includes("canon"));
  const numericas = conCanon.filter((p) => p.type === "number");
  const candidatas = numericas.length ? numericas : conCanon;
  if (candidatas.length === 1) return { elegida: candidatas[0], candidatas };
  const exactas = candidatas.filter((p) => ["canon", "canon de arrendamiento", "canon arrendamiento"].includes(normalizar(p.label)));
  return { elegida: exactas.length === 1 ? exactas[0] : null, candidatas };
}

async function listarPropietarios(hs: ClienteHS): Promise<PropietarioHS[]> {
  const todos: PropietarioHS[] = [];
  let after: string | undefined;
  do {
    const pagina = await hs.solicitar<{ results: PropietarioHS[]; paging?: { next?: { after: string } } }>(
      "GET",
      `/crm/v3/owners?limit=500&archived=false${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    todos.push(...pagina.results);
    after = pagina.paging?.next?.after;
  } while (after);
  return todos;
}

/**
 * Revisa todo lo que un flujo necesita de HubSpot y devuelve la configuración resuelta
 * (IDs del objeto, pipeline, etapas, propiedad de canon y propietarios), o null si algo falla.
 */
export async function diagnosticar(
  hs: ClienteHS,
  flujo: Flujo,
  pool: Persona[],
  params: Parametros,
  imprimir = true,
): Promise<{ cfg: ConfigHS | null; pasos: Paso[] }> {
  const pasos: Paso[] = [];
  const nota = (estado: Paso["estado"], texto: string) => {
    pasos.push({ estado, texto });
    // Sin el encabezado del diagnóstico completo, cada aviso dice de qué flujo es.
    if (imprimir || estado !== "ok") console.log(`${MARCA[estado]}${imprimir ? "" : `${flujo.nombre} · `}${texto}`);
  };
  const origenNomina = `data/${flujo.clave}/nomina.json`;

  // Datos locales
  nota("ok", `Nómina: ${pool.length} ${flujo.personas} activos (${pool.map((a) => a.etiqueta).join(", ")})`);
  const edad = Math.floor((Date.now() - Date.parse(`${params.calibradoCon.hasta}T00:00:00-05:00`)) / 86_400_000);
  if (edad > EDAD_MAX_PARAMETROS_DIAS) {
    nota("aviso", `Los parámetros se calibraron con datos hasta el ${params.calibradoCon.hasta} (hace ${edad} días). Hay que recalcularlos con --parametros antes de activar.`);
  } else {
    nota("ok", `Parámetros calibrados con ${params.calibradoCon.desde} → ${params.calibradoCon.hasta} (${params.calibradoCon.casos} casos)`);
  }

  // Objeto
  let objeto = valorDe(flujo, "OBJETO");
  if (objeto) {
    nota("ok", `Objeto: ${objeto} (fijado en ${variableDe(flujo, "OBJETO")})`);
  } else {
    try {
      const { results } = await hs.solicitar<{ results: SchemaHS[] }>("GET", "/crm/v3/schemas");
      const hallados = results.filter((s) => [s.labels?.singular, s.labels?.plural, s.name].some((t) => t && flujo.esObjeto(normalizar(t))));
      if (hallados.length === 1) {
        objeto = hallados[0].objectTypeId;
        nota("ok", `Objeto "${flujo.nombre}": ${objeto}`);
      } else if (hallados.length === 0) {
        const existentes = results.map((s) => s.labels?.plural ?? s.name ?? s.objectTypeId).join(", ") || "ninguno";
        nota("error", `No existe un objeto personalizado "${flujo.nombre}" en esta cuenta. Objetos personalizados que sí existen: ${existentes}.`);
      } else {
        nota("error", `Hay ${hallados.length} objetos que coinciden (${hallados.map((s) => s.objectTypeId).join(", ")}); hay que fijar el correcto en ${variableDe(flujo, "OBJETO")}.`);
      }
    } catch (error) {
      nota("error", `No se pudieron leer los objetos personalizados (scopes crm.schemas.custom.read y crm.objects.custom.read): ${mensajeDe(error)}`);
    }
  }

  // Pipeline y etapas
  let pipeline = valorDe(flujo, "PIPELINE");
  let etapaCola = valorDe(flujo, "ETAPA_COLA");
  let etapaDestino = valorDe(flujo, "ETAPA_DESTINO");
  const cola = normalizar(flujo.etapas.cola);
  const destino = normalizar(flujo.etapas.destino);
  if (objeto && !(pipeline && etapaCola && etapaDestino)) {
    try {
      const { results } = await hs.solicitar<{ results: PipelineHS[] }>("GET", `/crm/v3/pipelines/${objeto}`);
      const etapa = (p: PipelineHS, etiqueta: string) => p.stages.filter((s) => normalizar(s.label) === etiqueta);
      const validos = results.filter(
        (p) =>
          (!pipeline || p.id === pipeline) &&
          (etapaCola || etapa(p, cola).length === 1) &&
          (etapaDestino || etapa(p, destino).length === 1),
      );
      if (validos.length === 1) {
        const p = validos[0];
        pipeline = p.id;
        etapaCola ||= etapa(p, cola)[0].id;
        etapaDestino ||= etapa(p, destino)[0].id;
        nota("ok", `Pipeline "${p.label}" (${pipeline}): etapa de origen ${etapaCola}, etapa de destino ${etapaDestino}`);
      } else {
        const etapas = results.map((p) => `${p.label}: ${p.stages.map((s) => s.label).join(" / ")}`).join(" | ");
        nota(
          "error",
          `No se encontró una sola pipeline con las etapas "${flujo.etapas.cola}" y "${flujo.etapas.destino}" (se encontraron ${validos.length}). Pipelines: ${etapas || "ninguna"}. La pipeline y las etapas se pueden fijar con ${variableDe(flujo, "PIPELINE")}, ${variableDe(flujo, "ETAPA_COLA")} y ${variableDe(flujo, "ETAPA_DESTINO")}.`,
        );
      }
    } catch (error) {
      nota("error", `No se pudieron leer las etapas del objeto: ${mensajeDe(error)}`);
    }
  } else if (objeto) {
    nota("ok", `Pipeline ${pipeline}, etapas ${etapaCola} → ${etapaDestino} (fijadas por variables de entorno)`);
  }

  // Propiedades
  let propCanon = valorDe(flujo, "PROP_CANON");
  let fechaOk = false;
  if (objeto) {
    try {
      const { results } = await hs.solicitar<{ results: PropiedadHS[] }>("GET", `/crm/v3/properties/${objeto}`);
      const porNombre = new Map(results.map((p) => [p.name, p]));
      for (const sistema of ["hubspot_owner_id", "hs_pipeline", "hs_pipeline_stage"]) {
        if (!porNombre.has(sistema)) nota("error", `El objeto no tiene la propiedad del sistema ${sistema} (¿el objeto tiene pipeline y propietario?).`);
      }
      if (propCanon) {
        if (porNombre.has(propCanon)) nota("ok", `Propiedad de canon: ${propCanon} (fijada en ${variableDe(flujo, "PROP_CANON")})`);
        else nota("error", `${variableDe(flujo, "PROP_CANON")}=${propCanon} no existe en el objeto.`);
      } else {
        const { elegida, candidatas } = elegirPropCanon(results);
        if (elegida) {
          propCanon = elegida.name;
          nota("ok", `Propiedad de canon: ${propCanon} ("${elegida.label}", tipo ${elegida.type})`);
        } else {
          const lista = candidatas.map((p) => `${p.name} ("${p.label}", tipo ${p.type})`).join(", ");
          nota(
            "error",
            candidatas.length
              ? `Hay ${candidatas.length} propiedades que parecen el canon: ${lista}. Hay que fijar la correcta en ${variableDe(flujo, "PROP_CANON")}.`
              : `No se encontró una propiedad de canon (ninguna tiene "canon" en su nombre). Hay que crearla o fijar su nombre en ${variableDe(flujo, "PROP_CANON")}.`,
          );
        }
      }
      const fecha = porNombre.get("fecha_asignacion_analista");
      if (!fecha) nota("error", 'Falta la propiedad fecha_asignacion_analista: hay que crearla en el objeto con tipo "Fecha y hora".');
      else if (fecha.type !== "datetime") nota("error", `fecha_asignacion_analista es de tipo "${fecha.type}" y debe ser "Fecha y hora" (datetime): sin la hora no se puede ordenar el reparto del día.`);
      else {
        fechaOk = true;
        nota("ok", "Propiedad fecha_asignacion_analista (fecha y hora)");
      }
      if (!porNombre.has("asignacion_detalle")) nota("error", 'Falta la propiedad asignacion_detalle: hay que crearla en el objeto con tipo "Texto de varias líneas".');
      else nota("ok", "Propiedad asignacion_detalle");
    } catch (error) {
      nota("error", `No se pudieron leer las propiedades del objeto: ${mensajeDe(error)}`);
    }
  }

  // Propietarios ↔ nómina
  const claveDeOwner = new Map<string, string>();
  const ownerDeClave = new Map<string, string>();
  try {
    const propietarios = await listarPropietarios(hs);
    const nombreDe = (o: PropietarioHS) => `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email || o.id;
    for (const a of pool) {
      let hallados: PropietarioHS[];
      let criterio: string;
      if (a.ownerId) {
        hallados = propietarios.filter((o) => o.id === a.ownerId);
        criterio = `ownerId ${a.ownerId}`;
      } else if (a.correo) {
        hallados = propietarios.filter((o) => o.email?.toLowerCase() === a.correo?.toLowerCase());
        criterio = `correo ${a.correo}`;
      } else {
        hallados = propietarios.filter((o) => coincideNombre(a.nombre, `${o.firstName ?? ""} ${o.lastName ?? ""}`));
        criterio = `nombre "${a.nombre}"`;
      }
      if (hallados.length === 1) {
        const o = hallados[0];
        const repetido = claveDeOwner.get(o.id);
        if (repetido) {
          nota("error", `${a.etiqueta} y ${repetido} resuelven al mismo propietario de HubSpot (${nombreDe(o)}, id ${o.id}); hay que escribir el ownerId de cada uno en ${origenNomina}.`);
          continue;
        }
        claveDeOwner.set(o.id, a.clave);
        ownerDeClave.set(a.clave, o.id);
        nota("ok", `${a.etiqueta} → propietario ${nombreDe(o)} (id ${o.id}, por ${criterio})`);
      } else {
        const algunos = propietarios.slice(0, 15).map((o) => `${nombreDe(o)} (${o.id})`).join(", ");
        nota("error", `${a.etiqueta}: ${hallados.length ? "varios propietarios coinciden" : "no se encontró un propietario"} por ${criterio}. Hay que escribir su ownerId o su correo en ${origenNomina}. Propietarios de HubSpot: ${algunos || "ninguno"}${propietarios.length > 15 ? ", …" : ""}.`);
      }
    }
  } catch (error) {
    nota("error", `No se pudieron leer los propietarios (scope crm.objects.owners.read): ${mensajeDe(error)}`);
  }

  // Lectura de la cola
  if (objeto && pipeline && etapaCola && propCanon) {
    try {
      const prueba = await hs.solicitar<{ total?: number }>("POST", `/crm/v3/objects/${objeto}/search`, {
        filterGroups: filtrosCola(flujo, { pipeline, etapaCola }),
        limit: 1,
      });
      nota("ok", `Lectura de la cola: ${prueba.total ?? "?"} registro(s) esperando ${flujo.persona}`);
    } catch (error) {
      nota("error", `No se pudo leer la cola (scope crm.objects.custom.read): ${mensajeDe(error)}`);
    }
    // Con la misma consulta que usa cada ciclo: así un problema con el filtro o el orden aparece aquí y no en el primer reparto.
    if (fechaOk) {
      try {
        const prueba = await hs.solicitar<{ total?: number }>("POST", `/crm/v3/objects/${objeto}/search`, {
          ...cuerpoHistorial(propCanon, Date.now() - 30 * 86_400_000),
          limit: 1,
        });
        nota("ok", `Lectura del historial (fecha_asignacion_analista, últimos 30 días): ${prueba.total ?? "?"} registro(s)`);
      } catch (error) {
        nota("error", `No se pudo leer el historial de asignaciones: ${mensajeDe(error)}`);
      }
    }
  }

  const hayErrores = pasos.some((p) => p.estado === "error");
  if (hayErrores || !objeto || !pipeline || !etapaCola || !etapaDestino || !propCanon) return { cfg: null, pasos };
  return { cfg: { objeto, pipeline, etapaCola, etapaDestino, propCanon, claveDeOwner, ownerDeClave }, pasos };
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. CICLO DE ASIGNACIÓN
// ═════════════════════════════════════════════════════════════════════════════

/** El texto que queda en asignacion_detalle: por qué se eligió a esa persona. */
function textoDetalle(d: Decision, canon: number | null, presentes: Persona[], pool: Persona[], instante: number): string {
  const etiqueta = (clave: string) => pool.find((a) => a.clave === clave)?.etiqueta ?? clave;
  const candidatos = [...d.candidatos]
    .sort((x, y) => x.delta - y.delta)
    .map((c) => `${etiqueta(c.clave)} Δ=${c.delta.toFixed(3)}${c.clave === d.elegido ? " (elegido)" : ""}`)
    .join("; ");
  return [
    `Motor ${VERSION_MOTOR}`,
    `${horaLocal(instante)} hora Colombia`,
    canon === null ? "canon: sin dato, se usó el típico" : `canon ${cop(canon)}`,
    `w=${d.w.toFixed(2)}`,
    `presentes ${presentes.length}`,
    candidatos,
    ...(d.respaldo ? ["canon sobre el techo de todos los presentes: se eligió al de mayor experiencia"] : []),
  ].join(" | ");
}

/** El interruptor que frena este flujo (el general o el suyo), o null si no hay ninguno. */
function pausaActiva(flujo: Flujo): string | null {
  if (existsSync(RUTA.pausa)) return "data/PAUSA";
  return existsSync(rutaFlujo(flujo, "PAUSA")) ? `data/${flujo.clave}/PAUSA` : null;
}

/**
 * Un ciclo de un flujo: lee la cola, reconstruye los saldos, decide por orden de canon (de mayor a menor)
 * y, en modo activo, relee cada registro antes de escribirlo.
 */
export async function ejecutarCiclo(ctx: Contexto, ahora: number = Date.now()): Promise<ResumenCiclo> {
  const resumen: ResumenCiclo = { cola: 0, decididos: 0, escritos: 0, omitidos: 0 };
  const cal = ctx.calendario ?? cargarCalendario();
  const hoy = fechaBogota(ahora);
  const { cfg, params, flujo } = ctx;

  if (!ctx.ignorarHorario) {
    if (!esDiaLaboral(hoy, cal)) return { ...resumen, omitido: "hoy no es día laboral" };
    if (!dentroDeHorario(ahora)) return { ...resumen, omitido: "fuera del horario (7:30 a 4:30)" };
  }
  const pausa = pausaActiva(flujo);
  if (pausa) return { ...resumen, omitido: `interruptor de apagado activo (${pausa})` };

  const cola = await leerCola(ctx);
  resumen.cola = cola.length;
  if (!cola.length) return resumen;

  const presentes = presentesEn(hoy, ctx.pool, cal, ctx.ignorarHorario);
  if (!presentes.length) {
    alerta(flujo, "nadie_presente", `Hay ${cola.length} registro(s) en la cola y nadie presente hoy; quedan esperando.`);
    return { ...resumen, omitido: "nadie presente" };
  }
  if (ctx.modo === "activo" && cola.length > MAX_COLA_ACTIVA) {
    alerta(flujo, "cola_inusual", `La cola tiene ${cola.length} registros (más de ${MAX_COLA_ACTIVA}); no se escribe nada hasta que alguien la revise.`);
    return { ...resumen, omitido: "cola inusualmente grande" };
  }

  const desdeMs = Date.parse(`${inicioVentana(hoy, cal)}T00:00:00-05:00`);

  // En modo sombra los registros no salen de la cola: lo que ya se decidió dentro de la ventana no se vuelve a decidir.
  let pendientes = cola;
  if (ctx.modo === "sombra") {
    const ya = new Set(decisionesDelFlujo(ctx, desdeMs).filter((d) => d.escritura === ESCRITURA_SOMBRA).map((d) => d.id));
    pendientes = cola.filter((r) => !ya.has(r.id));
    if (!pendientes.length) return resumen;
  }

  const estado = reconstruirEstado(await leerHistorial(ctx, ahora, desdeMs), hoy, ctx.pool, cal, params);

  const ordenados = pendientes
    .map((registro) => ({ registro, canon: parsearCanon(registro.properties[cfg.propCanon]) }))
    .sort((x, y) => (y.canon ?? params.canonTipico) - (x.canon ?? params.canonTipico) || Number(x.registro.id) - Number(y.registro.id));

  for (const { registro, canon } of ordenados) {
    // Lo que tenía el registro antes de escribirlo: queda en el log para que revertir_asignacion.ts lo pueda restaurar.
    let anterior: Record<string, string | null> | null = null;
    if (ctx.modo === "activo") {
      const pausaAhora = pausaActiva(flujo);
      if (pausaAhora) return { ...resumen, omitido: `interruptor de apagado activo (${pausaAhora})` };
      // Releer: alguien pudo asignarlo o moverlo mientras tanto, o la búsqueda tardó en reflejar una escritura anterior.
      let actual: RegistroHS | null = null;
      try {
        actual = await ctx.hs.solicitar<RegistroHS>(
          "GET",
          `/crm/v3/objects/${cfg.objeto}/${registro.id}?properties=${PROPIEDADES_ESCRITAS.join(",")}`,
        );
      } catch (error) {
        if (!(error instanceof ErrorHubSpot && error.status === 404)) throw error; // 404: lo borraron o lo fusionaron
      }
      const sigueEnCola =
        actual !== null &&
        actual.properties.hs_pipeline_stage === cfg.etapaCola &&
        !(flujo.colaSinPropietario && actual.properties.hubspot_owner_id);
      if (!sigueEnCola) {
        const motivo = actual ? "ya no está en la cola (alguien lo asignó o lo movió)" : "el registro ya no existe";
        registrar({ tipo: "omitido", flujo: flujo.clave, modo: ctx.modo, entorno: ctx.entorno, id: registro.id, motivo });
        resumen.omitidos++;
        continue;
      }
      anterior = Object.fromEntries(PROPIEDADES_ESCRITAS.map((p) => [p, actual?.properties[p] ?? null]));
    }

    if (canon === null) alerta(flujo, "sin_canon", `El registro ${registro.id} no tiene un canon válido; se trató como canon típico.`, { id: registro.id });
    const d = asignarCaso(estado, presentes, canon, params);
    const elegido = ctx.pool.find((a) => a.clave === d.elegido)!;
    const ownerId = cfg.ownerDeClave.get(d.elegido)!;
    const instante = Date.now();
    const escrito = {
      hubspot_owner_id: ownerId,
      hs_pipeline_stage: cfg.etapaDestino,
      fecha_asignacion_analista: new Date(instante).toISOString(),
    };
    const linea = {
      tipo: "decision",
      flujo: flujo.clave,
      modo: ctx.modo,
      entorno: ctx.entorno,
      objeto: cfg.objeto,
      id: registro.id,
      canon,
      w: redondear(d.w, 4),
      sinCanon: d.sinCanon,
      respaldo: d.respaldo,
      presentes: presentes.map((a) => a.clave),
      candidatos: d.candidatos.map((c) => ({ clave: c.clave, delta: redondear(c.delta, 4), e: redondear(c.e, 4), E: redondear(c.E, 4) })),
      elegido: d.elegido,
      ownerId,
      // En modo activo: lo que el registro tenía antes y lo que se le escribe, para poder revertirlo.
      ...(anterior ? { anterior, escrito } : {}),
    };

    let escritura = ESCRITURA_SOMBRA;
    if (ctx.modo === "activo") {
      try {
        await ctx.hs.solicitar("PATCH", `/crm/v3/objects/${cfg.objeto}/${registro.id}`, {
          properties: { ...escrito, asignacion_detalle: textoDetalle(d, canon, presentes, ctx.pool, instante) },
        });
        escritura = "ok";
      } catch (error) {
        // El estado en memoria ya cuenta esta decisión: se corta el ciclo y el siguiente reconstruye todo desde HubSpot.
        registrar({ ...linea, escritura: `error: ${mensajeDe(error)}` }, instante);
        throw error;
      }
      resumen.escritos++;
    }
    registrar({ ...linea, escritura }, instante);
    resumen.decididos++;
    console.log(`  ${flujo.nombre} #${registro.id}  canon ${canon === null ? "sin dato" : cop(canon)}  →  ${elegido.etiqueta}  (Δ ${d.candidatos.find((c) => c.clave === d.elegido)!.delta.toFixed(3)})${d.respaldo ? "  [respaldo: sobre el techo de todos]" : ""}  [${ctx.modo}]`);
  }
  return resumen;
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. EJECUCIÓN: CANDADO, ARRANQUE Y BUCLE
// ═════════════════════════════════════════════════════════════════════════════

const procesoVivo = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Una sola instancia a la vez (para todos los flujos). Devuelve la función que libera el candado. */
export function tomarCandado(): () => void {
  mkdirSync(dirname(RUTA.candado), { recursive: true });
  for (let intento = 0; intento < 2; intento++) {
    try {
      writeFileSync(RUTA.candado, String(process.pid), { flag: "wx" });
      const liberar = () => {
        try {
          if (readFileSync(RUTA.candado, "utf8") === String(process.pid)) unlinkSync(RUTA.candado);
        } catch {
          // Ya no existe: nada que liberar.
        }
      };
      process.once("exit", liberar);
      return liberar;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(RUTA.candado, "utf8"));
      if (procesoVivo(pid)) {
        throw new ErrorOcupado(pid, Math.floor((Date.now() - statSync(RUTA.candado).mtimeMs) / 60_000));
      }
      unlinkSync(RUTA.candado); // Quedó de una ejecución que terminó mal.
    }
  }
  throw new ErrorUso(`No se pudo tomar el candado ${RUTA.candado}.`);
}

interface Arranque {
  modo: Modo;
  entorno: Entorno;
  hs: ClienteHS;
  ignorarHorario: boolean;
  flujos: Flujo[];
}

const esFatal = (error: unknown) => error instanceof ErrorHubSpot && (error.status === 401 || error.status === 403);

/** Recarga nómina y parámetros de cada flujo y revisa HubSpot. Falla si algún flujo no está listo. */
async function prepararContextos(a: Arranque, imprimir: boolean): Promise<Contexto[]> {
  const contextos: Contexto[] = [];
  const fallidos: Flujo[] = [];
  for (const flujo of a.flujos) {
    const { pool } = cargarNomina(flujo);
    const params = cargarParametros(flujo, pool);
    if (imprimir) console.log(`\n── ${flujo.nombre} ──`);
    const { cfg } = await diagnosticar(a.hs, flujo, pool, params, imprimir);
    if (cfg) contextos.push({ flujo, modo: a.modo, entorno: a.entorno, hs: a.hs, cfg, pool, params, ignorarHorario: a.ignorarHorario });
    else fallidos.push(flujo);
  }
  if (fallidos.length) {
    const listos = a.flujos.filter((f) => !fallidos.includes(f));
    throw new ErrorUso(
      `El diagnóstico de ${fallidos.map((f) => f.nombre).join(" y ")} encontró errores. Se revisan con: node asignacion_equilibrada.ts --diagnostico` +
        (listos.length ? `. Para correr solo lo que está listo, hay que agregar:${listos.map((f) => `--flujo ${f.clave}`).join(" ")}` : ""),
    );
  }
  return contextos;
}

function textoResumen(r: ResumenCiclo, modo: Modo): string {
  return `cola ${r.cola}: decididos ${r.decididos}${modo === "activo" ? `, escritos ${r.escritos}` : " (modo sombra: no se escribió nada)"}${r.omitidos ? `, omitidos ${r.omitidos}` : ""}`;
}

async function bucle(a: Arranque, contextosIniciales: Contexto[]): Promise<void> {
  let contextos = contextosIniciales;
  let fechaDiagnostico = fechaBogota(Date.now());
  let detener = false;
  const parar = () => {
    detener = true;
    console.log("Señal recibida: el script termina el ciclo en curso y sale.");
  };
  process.once("SIGINT", parar);
  process.once("SIGTERM", parar);

  const ultimoOmitido = new Map<string, string>();
  while (!detener) {
    const inicio = Date.now();
    // Cada día se recargan nóminas y parámetros y se revisa HubSpot de nuevo (nuevos propietarios, etapas, etc.).
    if (fechaBogota(inicio) !== fechaDiagnostico) {
      try {
        contextos = await prepararContextos(a, false);
        fechaDiagnostico = fechaBogota(inicio);
      } catch (error) {
        alerta(null, "diagnostico_diario", `No se pudo renovar la configuración; el script sigue con la anterior:${mensajeDe(error)}`);
      }
    }
    for (const ctx of contextos) {
      if (detener) break;
      try {
        const resumen = await ejecutarCiclo(ctx, inicio);
        // Solo cuando pasó algo: un ciclo sin cola, o con una cola ya decidida en modo sombra, no se anota cada 2 minutos.
        if (!resumen.omitido && (resumen.decididos > 0 || resumen.omitidos > 0)) {
          console.log(`[${horaLocal(inicio)}] ${ctx.flujo.nombre}: ${textoResumen(resumen, ctx.modo)}`);
        }
        const omitido = resumen.omitido ?? "";
        if (omitido && omitido !== ultimoOmitido.get(ctx.flujo.clave)) console.log(`[${horaLocal(inicio)}] ${ctx.flujo.nombre}: ciclo omitido: ${omitido}`);
        ultimoOmitido.set(ctx.flujo.clave, omitido);
      } catch (error) {
        // Con el token inválido o sin scopes reintentar cada 2 minutos no sirve: se sale.
        if (esFatal(error)) throw error;
        alerta(ctx.flujo, "error_ciclo", mensajeDe(error));
      }
    }
    while (!detener && Date.now() - inicio < INTERVALO_MS) await dormir(Math.min(1000, INTERVALO_MS - (Date.now() - inicio)));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. PARÁMETROS DESDE AGSSA (--parametros)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Techo T_j (P99 del canon de cada uno), canon típico m̄ y pesos c y s por rol.
 * c = casos por día trabajado y s = canon por día trabajado (en cánones típicos), promediados por rol
 * y divididos entre el mayor, igual que en las simulaciones del plan. Con un solo rol, c = s = 1.
 */
export function calcularParametros(casos: CasoHistorico[], pool: Persona[], ventana: { desde: string; hasta: string }): Parametros {
  const porClave = new Map<string, CasoHistorico[]>(pool.map((a) => [a.clave, []]));
  for (const c of casos) if (c.canon > 0) porClave.get(c.clave)?.push(c);
  for (const a of pool) {
    const n = porClave.get(a.clave)!.length;
    if (n < MIN_CASOS_POR_PERSONA) {
      throw new ErrorUso(`${a.etiqueta} solo tiene ${n} casos con canon entre ${ventana.desde} y ${ventana.hasta} (mínimo ${MIN_CASOS_POR_PERSONA}). Hay que ampliar la ventana con --desde y --hasta o sacar a la persona de la nómina activa.`);
    }
  }
  const todos = [...porClave.values()].flat();
  const canonTipico = promedio(todos.map((c) => c.canon));

  const porRol = new Map<Rol, { c: number[]; s: number[] }>();
  const techos: Record<string, number> = {};
  for (const a of pool) {
    const mios = porClave.get(a.clave)!;
    const dias = new Set(mios.map((c) => c.dia)).size;
    techos[a.clave] = Math.round(cuantil(mios.map((c) => c.canon), 0.99));
    const fila = porRol.get(a.rol) ?? { c: [], s: [] };
    porRol.set(a.rol, fila);
    fila.c.push(mios.length / dias);
    fila.s.push(mios.reduce((suma, c) => suma + c.canon, 0) / canonTipico / dias);
  }
  const promedios = [...porRol].map(([rol, fila]) => ({ rol, c: promedio(fila.c), s: promedio(fila.s) }));
  const maxC = Math.max(...promedios.map((r) => r.c));
  const maxS = Math.max(...promedios.map((r) => r.s));
  return {
    generado: new Date().toISOString(),
    calibradoCon: { desde: ventana.desde, hasta: ventana.hasta, casos: todos.length },
    canonTipico: Math.round(canonTipico),
    roles: Object.fromEntries(promedios.map((r) => [r.rol, { c: redondear(r.c / maxC, 6), s: redondear(r.s / maxS, 6) }])),
    techos,
  };
}

/** Casos asignados (persona, fecha de asignación y canon) desde AGSSA con sqlcmd. `hasta` no se incluye. */
function extraerCasosAGSSA(flujo: Flujo, desde: string, hasta: string, pool: Persona[]): { casos: CasoHistorico[]; ultimaFecha: string } {
  const servidor = process.env.AGSSA_SERVIDOR ?? ".\\SQLEXPRESS";
  const base = process.env.AGSSA_BASE ?? "AGSSA_PROD";
  const documentos = pool.map((a) => `'${a.documento.replace(/[^0-9A-Za-z]/g, "")}'`).join(",");
  const ejecutar = (sql: string): string[] => {
    const r = spawnSync("sqlcmd", ["-S", servidor, "-d", base, "-E", "-C", "-b", "-W", "-h", "-1", "-s", "|", "-Q", `SET NOCOUNT ON; ${sql}`], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) throw new ErrorUso(`No se pudo ejecutar sqlcmd (¿está instalado y en el PATH?): ${r.error.message}`);
    if (r.status !== 0) throw new ErrorUso(`sqlcmd falló: ${`${r.stdout}${r.stderr}`.trim().slice(0, 500)}`);
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  };

  const ultimaFecha = ejecutar(flujo.agssa.ultimaFecha)[0] ?? "";
  const claveDe = new Map(pool.map((a) => [a.documento, a.clave]));
  const casos: CasoHistorico[] = [];
  for (const linea of ejecutar(flujo.agssa.casos(documentos, desde, hasta))) {
    const [id, fecha, documento, canon] = linea.split("|");
    const clave = claveDe.get(documento);
    const valor = Number(canon);
    if (clave && fecha && Number.isFinite(valor)) casos.push({ id, dia: fecha.slice(0, 10), clave, canon: valor });
  }
  return { casos, ultimaFecha };
}

function generarParametros(flujos: Flujo[], desdeArg?: string, hastaArg?: string): number {
  const formato = /^\d{4}-\d{2}-\d{2}$/;
  const hasta = hastaArg ?? fechaBogota(Date.now());
  let desde = desdeArg;
  if (!desde) {
    const d = new Date(`${hasta}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 3);
    desde = d.toISOString().slice(0, 10);
  }
  if (!formato.test(desde) || !formato.test(hasta) || desde >= hasta) {
    throw new ErrorUso("--desde y --hasta deben ser AAAA-MM-DD, con --desde anterior a --hasta (la fecha final no se incluye).");
  }

  // Primero se calcula todo y luego se guarda: si un flujo falla, no queda uno actualizado y el otro no.
  const listos: { flujo: Flujo; pool: Persona[]; params: Parametros }[] = [];
  for (const flujo of flujos) {
    const { pool } = cargarNomina(flujo);
    console.log(`${flujo.nombre}: leyendo AGSSA, casos de ${pool.length} ${flujo.personas} entre ${desde} y ${hasta}…`);
    const { casos, ultimaFecha } = extraerCasosAGSSA(flujo, desde, hasta, pool);
    const atraso = Math.floor((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${ultimaFecha}T00:00:00Z`)) / 86_400_000);
    if (!ultimaFecha || atraso > 15) {
      throw new ErrorUso(`${flujo.nombre}: AGSSA solo tiene asignaciones hasta el ${ultimaFecha || "(sin datos)"} y la ventana termina el ${hasta}: faltan datos recientes. Hay que actualizar la base o indicar --hasta.`);
    }
    listos.push({ flujo, pool, params: calcularParametros(casos, pool, { desde, hasta }) });
  }

  for (const { flujo, pool, params } of listos) {
    const ruta = rutaFlujo(flujo, "parametros.json");
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, JSON.stringify(params, null, 2) + "\n");
    console.log(`\n${flujo.nombre} · m̄ (canon típico): ${cop(params.canonTipico)}   |   casos usados: ${params.calibradoCon.casos}`);
    console.table(
      Object.fromEntries(
        pool.map((a) => [a.etiqueta, { rol: a.rol, "techo T_j": cop(params.techos[a.clave]), c: params.roles[a.rol].c, s: params.roles[a.rol].s }]),
      ),
    );
    console.log(`Guardado en ${ruta}`);
  }
  return 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. AUTOPRUEBA (--autoprueba): el motor y sus alrededores, sin HubSpot ni AGSSA
// ═════════════════════════════════════════════════════════════════════════════

function autoprueba(): number {
  const mulberry32 = (semilla: number) => () => {
    semilla = (semilla + 0x6d2b79f5) | 0;
    let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const persona = (clave: string, rol: Rol): Persona => ({ clave, etiqueta: clave, nombre: clave, rol, documento: clave, ownerId: null, correo: null, activo: true });
  const pool = [persona("a1", "analista"), persona("a2", "analista"), persona("a3", "analista"), persona("a4", "analista"), persona("c1", "coordinador"), persona("c2", "coordinador")];
  const claves = pool.map((a) => a.clave);
  const p: Parametros = {
    generado: "prueba",
    calibradoCon: { desde: "2026-01-01", hasta: "2026-04-01", casos: 1000 },
    canonTipico: 3_460_000,
    roles: { analista: { c: 1, s: 0.66 }, coordinador: { c: 0.31, s: 1 } },
    techos: { a1: 6_000_000, a2: 5_600_000, a3: 6_050_000, a4: 9_500_000, c1: 74_100_000, c2: 130_500_000 },
  };
  const calSemana: Calendario = { diasLaborales: [1, 2, 3, 4, 5], ausencias: [] };
  const cerca = (x: number, y: number, tolerancia = 1e-9) => assert.ok(Math.abs(x - y) <= tolerancia, `${x} no es ${y}`);
  const suma = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);
  const rango = (o: Record<string, number>) => Math.max(...Object.values(o)) - Math.min(...Object.values(o));
  const riesgo = FLUJOS.find((f) => f.clave === "analisis_riesgo")!;
  const contratos = FLUJOS.find((f) => f.clave === "contratos")!;

  const pruebas: [string, () => void][] = [
    ["lo que sube la meta es lo que se reparte: Σe y ΣE no se desvían", () => {
      const azar = mulberry32(1);
      const estado = estadoVacio(claves);
      for (let i = 0; i < 2000; i++) asignarCaso(estado, pool, 1_000_000 + azar() * 12_000_000, p);
      cerca(suma(estado.e), 0, 1e-6);
      cerca(suma(estado.E), 0, 1e-6);
    }],
    ["techo duro: un canon sobre el techo de los analistas siempre va a un coordinador", () => {
      const azar = mulberry32(2);
      const estado = estadoVacio(claves);
      for (let i = 0; i < 400; i++) {
        const d = asignarCaso(estado, pool, 10_000_000 + azar() * 60_000_000, p);
        assert.ok(d.elegido === "c1" || d.elegido === "c2", `fue a ${d.elegido}`);
      }
    }],
    ["techo duro: entre 6,05M y 9,5M solo compiten a4 y los coordinadores", () => {
      const azar = mulberry32(3);
      const estado = estadoVacio(claves);
      for (let i = 0; i < 400; i++) {
        const d = asignarCaso(estado, pool, 6_100_000 + azar() * 3_000_000, p);
        assert.ok(["a4", "c1", "c2"].includes(d.elegido), `fue a ${d.elegido}`);
      }
    }],
    ["si el canon supera el techo de todos los presentes va al de mayor techo y se marca el respaldo", () => {
      const d = asignarCaso(estadoVacio(claves), pool.filter((a) => a.clave === "a1" || a.clave === "a2"), 8_000_000, p);
      assert.equal(d.elegido, "a1");
      assert.equal(d.respaldo, true);
    }],
    ["con el estado en cero, un caso pequeño va a un analista y no a un coordinador", () => {
      const d = asignarCaso(estadoVacio(claves), pool, 1_000_000, p);
      assert.equal(pool.find((a) => a.clave === d.elegido)!.rol, "analista");
    }],
    ["empate: gana el primero de la nómina y luego el reparto rota", () => {
      const cuatro = pool.slice(0, 4);
      const estado = estadoVacio(claves);
      const orden = [1, 2, 3, 4].map(() => asignarCaso(estado, cuatro, p.canonTipico, p).elegido);
      assert.deepEqual(orden, ["a1", "a2", "a3", "a4"]);
    }],
    ["un caso sin canon cuenta como típico (w = 1) y se marca", () => {
      const d = asignarCaso(estadoVacio(claves), pool, null, p);
      assert.equal(d.sinCanon, true);
      cerca(d.w, 1);
    }],
    ["un ausente no recibe casos ni acumula deuda", () => {
      const cal: Calendario = { diasLaborales: [1, 2, 3, 4, 5], ausencias: [{ persona: "a4", desde: "2026-11-04", hasta: "2026-11-04" }] };
      const presentes = presentesEn("2026-11-04", pool, cal);
      assert.ok(!presentes.some((a) => a.clave === "a4"));
      const eventos: Evento[] = [0, 1, 2, 3, 4, 5].map((i) => ({ id: String(i), instante: Date.parse(`2026-11-04T08:0${i}:00-05:00`), clave: presentes[i % presentes.length].clave, canon: 3_000_000 }));
      const estado = reconstruirEstado(eventos, "2026-11-04", pool, cal, p);
      assert.equal(estado.e.a4, 0);
      assert.equal(estado.E.a4, 0);
    }],
    ["la memoria: dos días hábiles después los saldos valen 0,9² de lo que valían", () => {
      const eventos: Evento[] = [0, 1, 2, 3].map((i) => ({ id: String(i), instante: Date.parse(`2026-11-02T08:0${i}:00-05:00`), clave: ["a1", "a1", "a2", "c1"][i], canon: 2_000_000 + i * 1_500_000 }));
      const lunes = reconstruirEstado(eventos, "2026-11-02", pool, calSemana, p);
      const miercoles = reconstruirEstado(eventos, "2026-11-04", pool, calSemana, p);
      for (const k of claves) {
        cerca(miercoles.e[k], lunes.e[k] * 0.81);
        cerca(miercoles.E[k], lunes.E[k] * 0.81);
      }
    }],
    ["reconstruir desde el historial da el mismo estado que repartir en vivo", () => {
      const cal: Calendario = { diasLaborales: [1, 2, 3, 4, 5], ausencias: [{ persona: "a3", desde: "2026-11-04", hasta: "2026-11-04" }] };
      const azar = mulberry32(5);
      const vivo = estadoVacio(claves);
      const eventos: Evento[] = [];
      for (const dia of ["2026-11-02", "2026-11-03", "2026-11-04"]) {
        aplicarMemoria(vivo);
        const presentes = presentesEn(dia, pool, cal);
        for (let i = 0; i < 40; i++) {
          const canon = azar() < 0.05 ? null : 1_500_000 + azar() * 9_000_000;
          const d = asignarCaso(vivo, presentes, canon, p);
          eventos.push({ id: `${dia}-${i}`, instante: Date.parse(`${dia}T08:${String(i).padStart(2, "0")}:00-05:00`), clave: d.elegido, canon });
        }
      }
      const reconstruido = reconstruirEstado(eventos, "2026-11-04", pool, cal, p);
      for (const k of claves) {
        cerca(reconstruido.e[k], vivo.e[k]);
        cerca(reconstruido.E[k], vivo.E[k]);
      }
    }],
    ["los eventos de quien no está en la nómina activa se ignoran", () => {
      const estado = reconstruirEstado([{ id: "1", instante: Date.parse("2026-11-02T08:00:00-05:00"), clave: "deicy_p", canon: 2_000_000 }], "2026-11-02", pool, calSemana, p);
      cerca(suma(estado.e), 0);
    }],
    ["canon: solo cuenta lo mayor que cero y legible", () => {
      assert.equal(parsearCanon("3500000"), 3_500_000);
      assert.equal(parsearCanon("3500000.50"), 3_500_000.5);
      for (const malo of [null, undefined, "", "abc", "0", "-5"]) assert.equal(parsearCanon(malo), null);
    }],
    ["fechas de HubSpot: ISO y milisegundos", () => {
      assert.equal(parsearInstante("2026-11-05T12:31:00.000Z"), Date.parse("2026-11-05T12:31:00Z"));
      assert.equal(parsearInstante("1793882400000"), 1793882400000);
      assert.equal(parsearInstante(""), null);
    }],
    ["horario: de 7:30 a 4:30 hora de Colombia", () => {
      const a = (hora: string) => dentroDeHorario(Date.parse(`2026-11-05T${hora}-05:00`));
      assert.deepEqual([a("07:29:59"), a("07:30:00"), a("12:00:00"), a("16:30:30"), a("16:31:00")], [false, true, true, true, false]);
    }],
    ["calendario: sábado, domingo y festivo no son laborales", () => {
      const cal: Calendario = { diasLaborales: [1, 2, 3, 4, 5], ausencias: [{ persona: "*", desde: "2026-11-16", hasta: "2026-11-16" }] };
      assert.deepEqual(["2026-11-05", "2026-11-07", "2026-11-08", "2026-11-16", "2026-11-17"].map((f) => esDiaLaboral(f, cal)), [true, false, false, false, true]);
    }],
    ["ventana: cinco días hábiles antes del jueves 5 de noviembre es el jueves 29 de octubre", () => {
      assert.equal(inicioVentana("2026-11-05", calSemana, 5), "2026-10-29");
    }],
    ["cuantil con interpolación lineal", () => {
      cerca(cuantil([1, 2, 3, 4], 0.5), 2.5);
      cerca(cuantil(Array.from({ length: 100 }, (_, i) => i + 1), 0.99), 99.01);
    }],
    ["parámetros: pesos por rol normalizados al mayor y techo P99", () => {
      const miniPool = [persona("a1", "analista"), persona("a2", "analista"), persona("c1", "coordinador")];
      const casos: CasoHistorico[] = [];
      // a1 y a2: 200 casos en 100 días (2 por día) de 1M; c1: 100 casos en 100 días (1 por día) de 5M.
      for (let d = 0; d < 100; d++) {
        const dia = sumarDias("2026-01-01", d);
        for (const k of ["a1", "a2"]) for (let j = 0; j < 2; j++) casos.push({ id: `${k}${d}${j}`, dia, clave: k, canon: 1_000_000 });
        casos.push({ id: `c${d}`, dia, clave: "c1", canon: 5_000_000 });
      }
      const r = calcularParametros(casos, miniPool, { desde: "2026-01-01", hasta: "2026-04-11" });
      cerca(r.canonTipico, (400 * 1_000_000 + 100 * 5_000_000) / 500);
      cerca(r.roles.analista.c, 1);
      cerca(r.roles.coordinador.c, 0.5);
      cerca(r.roles.coordinador.s, 1);
      cerca(r.roles.analista.s, (2 * 1_000_000) / (1 * 5_000_000));
      assert.equal(r.techos.a1, 1_000_000);
      assert.equal(r.techos.c1, 5_000_000);
    }],
    ["nombres: el de HubSpot debe estar contenido en el de la nómina (y al revés), con nombre y apellido", () => {
      assert.ok(coincideNombre("GERMAN ANDRES ERAZO FORERO", "Germán Erazo"));
      assert.ok(coincideNombre("Maria Monica Torralba Leuro", "María Torralba"));
      assert.ok(!coincideNombre("GERMAN ANDRES ERAZO FORERO", "German"));
      assert.ok(!coincideNombre("GERMAN ANDRES ERAZO FORERO", "Eliana Rojas"));
    }],
    ["un solo rol (ejecutivos): los casos y el canon quedan parejos entre todos", () => {
      const ejecutivos = ["e1", "e2", "e3", "e4", "e5"].map((k) => persona(k, "ejecutivo"));
      const pe: Parametros = { ...p, canonTipico: 2_500_000, roles: { ejecutivo: { c: 1, s: 1 } }, techos: { e1: 9e6, e2: 9e6, e3: 9e6, e4: 9e6, e5: 9e6 } };
      const azar = mulberry32(7);
      const estado = estadoVacio(ejecutivos.map((a) => a.clave));
      for (let i = 0; i < 1000; i++) asignarCaso(estado, ejecutivos, 800_000 + azar() * 5_000_000, pe);
      // Todos presentes y sin memoria: e es casos recibidos − 200 y E es canon recibido − la quinta parte del total.
      assert.ok(rango(estado.e) <= 2 + 1e-9, `casos: diferencia de ${rango(estado.e).toFixed(2)} entre el que más y el que menos`);
      assert.ok(rango(estado.E) <= 2 + 1e-9, `canon: diferencia de ${rango(estado.E).toFixed(2)} cánones típicos`);
    }],
    ["parámetros con un solo rol: c = s = 1 y un techo por persona", () => {
      const dos = [persona("e1", "ejecutivo"), persona("e2", "ejecutivo")];
      const casos: CasoHistorico[] = [];
      for (let d = 0; d < 60; d++) {
        const dia = sumarDias("2026-04-01", d);
        for (let j = 0; j < 3; j++) casos.push({ id: `e1${d}${j}`, dia, clave: "e1", canon: 2_000_000 });
        for (let j = 0; j < 2; j++) casos.push({ id: `e2${d}${j}`, dia, clave: "e2", canon: 4_000_000 });
      }
      const r = calcularParametros(casos, dos, { desde: "2026-04-01", hasta: "2026-05-31" });
      assert.deepEqual(Object.keys(r.roles), ["ejecutivo"]);
      cerca(r.roles.ejecutivo.c, 1);
      cerca(r.roles.ejecutivo.s, 1);
      assert.equal(r.techos.e1, 2_000_000);
      assert.equal(r.techos.e2, 4_000_000);
    }],
    ["la cola: Análisis de riesgo exige que no haya propietario; Contratos no (el que traiga se reemplaza)", () => {
      const cfg = { pipeline: "pipe", etapaCola: "etapa" };
      const deRiesgo = filtrosCola(riesgo, cfg)[0].filters;
      const deContratos = filtrosCola(contratos, cfg)[0].filters;
      assert.ok(deRiesgo.some((f) => f.propertyName === "hubspot_owner_id" && f.operator === "NOT_HAS_PROPERTY"));
      assert.ok(!deContratos.some((f) => f.propertyName === "hubspot_owner_id"));
      assert.deepEqual(deContratos.map((f) => f.value), ["pipe", "etapa"]);
    }],
    ["objetos: Contratos se reconoce por su nombre exacto y no se confunde con 'Orden de contrato'", () => {
      assert.ok(contratos.esObjeto(normalizar("Contratos")) && contratos.esObjeto(normalizar("Contrato")));
      assert.ok(!contratos.esObjeto(normalizar("Orden de contrato")) && !contratos.esObjeto(normalizar("Análisis de riesgo")));
      assert.ok(riesgo.esObjeto(normalizar("Análisis de riesgo")) && !riesgo.esObjeto(normalizar("Contratos")));
    }],
    ["propiedad de canon: entre varias, la numérica; si quedan varias, la que se llama Canon; si no, no adivina", () => {
      const prop = (name: string, label: string, type: string) => ({ name, label, type });
      assert.equal(elegirPropCanon([prop("canon", "Canon", "number"), prop("devolucion_primer_canon", "Devolución primer canon", "string"), prop("valor", "Valor", "number")]).elegida?.name, "canon");
      assert.equal(elegirPropCanon([prop("canon_admon", "Canon más administración", "number"), prop("canon", "Canon", "number")]).elegida?.name, "canon");
      const dudosa = elegirPropCanon([prop("canon_inicial", "Canon inicial", "number"), prop("canon_actual", "Canon actual", "number")]);
      assert.equal(dudosa.elegida, null);
      assert.equal(dudosa.candidatas.length, 2);
      assert.equal(elegirPropCanon([prop("valor", "Valor", "number")]).elegida, null);
    }],
    ["nómina: el rol tiene que ser de su flujo y tiene que haber alguien activo", () => {
      const base = { clave: "x1", nombre: "Xiomara Uno", documento: "1", rol: "ejecutivo" };
      assert.equal(validarNomina({ personas: [base] }, contratos, "prueba").pool.length, 1);
      assert.throws(() => validarNomina({ personas: [base] }, riesgo, "prueba"), /'rol' debe ser "analista" o "coordinador"/);
      assert.throws(() => validarNomina({ personas: [{ ...base, activo: false }] }, contratos, "prueba"), /no hay ejecutivos activos/);
    }],
  ];

  let fallas = 0;
  for (const [nombre, prueba] of pruebas) {
    try {
      prueba();
      console.log(`  ok     ${nombre}`);
    } catch (error) {
      fallas++;
      console.error(`  FALLA  ${nombre}\n         ${mensajeDe(error)}`);
    }
  }
  console.log(fallas ? `\n${fallas} de ${pruebas.length} pruebas fallaron.` : `\nLas ${pruebas.length} pruebas pasaron.`);
  return fallas ? 1 : 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. PUNTO DE ENTRADA
// ═════════════════════════════════════════════════════════════════════════════

const AYUDA = `Asignación equilibrada (motor ${VERSION_MOTOR}): ${FLUJOS.map((f) => f.nombre).join(" y ")}

  node asignacion_equilibrada.ts                  ciclo continuo cada 2 min en MODO SOMBRA (no escribe en HubSpot)
  node asignacion_equilibrada.ts --activar        igual, pero escribe en HubSpot
  node asignacion_equilibrada.ts --una-vez        un solo ciclo y termina (n8n o Programador de tareas); fuera de horario,
                                                  en pausa o con otra ejecución en curso sale con 0 sin tocar HubSpot
  node asignacion_equilibrada.ts --diagnostico    revisa token, scopes, objetos, etapas, propiedades y propietarios
  node asignacion_equilibrada.ts --parametros     recalcula data/<flujo>/parametros.json desde AGSSA [--desde AAAA-MM-DD --hasta AAAA-MM-DD]
  node asignacion_equilibrada.ts --autoprueba     pruebas del motor

  --flujo <clave>     solo ese flujo (${FLUJOS.map((f) => f.clave).join(" o ")}); se puede repetir. Por defecto, todos
  --produccion        usa HUBSPOT_TOKEN en lugar de HUBSPOT_TOKEN_SANDBOX
  --ignorar-horario   ejecuta el ciclo fuera de 7:30 a 4:30 y en días no laborales (pruebas)
`;

/** Por qué un ciclo de --una-vez no correría, mirando solo datos locales (calendario, hora y PAUSA); null si sí corre. */
function motivoParaNoCorrer(flujos: Flujo[], ignorarHorario: boolean, ahora: number): string | null {
  if (!ignorarHorario) {
    if (!esDiaLaboral(fechaBogota(ahora), cargarCalendario())) return "hoy no es día laboral";
    if (!dentroDeHorario(ahora)) return "fuera del horario (7:30 a 4:30)";
  }
  const pausas = flujos.map(pausaActiva);
  if (pausas.every((p) => p !== null)) return `interruptor de apagado activo (${[...new Set(pausas)].join(", ")})`;
  return null;
}

function elegirFlujos(claves: string[] | undefined): Flujo[] {
  if (!claves?.length) return [...FLUJOS];
  for (const clave of claves) {
    if (!FLUJOS.some((f) => f.clave === clave)) throw new ErrorUso(`El flujo "${clave}" no existe. Los flujos son: ${FLUJOS.map((f) => f.clave).join(", ")}.`);
  }
  return FLUJOS.filter((f) => claves.includes(f.clave));
}

async function main(argumentos: string[]): Promise<number> {
  let valores;
  try {
    ({ values: valores } = parseArgs({
      args: argumentos,
      strict: true,
      options: {
        activar: { type: "boolean" },
        produccion: { type: "boolean" },
        "una-vez": { type: "boolean" },
        diagnostico: { type: "boolean" },
        parametros: { type: "boolean" },
        autoprueba: { type: "boolean" },
        "ignorar-horario": { type: "boolean" },
        flujo: { type: "string", multiple: true },
        desde: { type: "string" },
        hasta: { type: "string" },
        ayuda: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`${mensajeDe(error)}\n\n${AYUDA}`);
    return 2;
  }
  if (valores.ayuda) {
    console.log(AYUDA);
    return 0;
  }
  if (valores.autoprueba) return autoprueba();

  const flujos = elegirFlujos(valores.flujo);
  cargarEnv();
  if (valores.parametros) return generarParametros(flujos, valores.desde, valores.hasta);

  // Antes de tocar HubSpot: la nómina y los parámetros de cada flujo deben estar bien.
  for (const flujo of flujos) cargarParametros(flujo, cargarNomina(flujo).pool);
  const { entorno, token } = elegirEntorno(valores.produccion === true);
  const hs = crearCliente(token, urlBase());

  if (valores.diagnostico) {
    console.log(`Diagnóstico en ${entorno}`);
    let listos = 0;
    for (const flujo of flujos) {
      console.log(`\n── ${flujo.nombre} ──`);
      const { pool } = cargarNomina(flujo);
      const { cfg } = await diagnosticar(hs, flujo, pool, cargarParametros(flujo, pool), true);
      if (cfg) listos++;
    }
    const todos = listos === flujos.length;
    console.log(todos ? "\nTodo listo para correr el script." : `\nHay errores por resolver antes de correr el script (${flujos.length - listos} de ${flujos.length} flujos).`);
    return todos ? 0 : 2;
  }

  const arranque: Arranque = {
    modo: valores.activar ? "activo" : "sombra",
    entorno,
    hs,
    ignorarHorario: valores["ignorar-horario"] === true,
    flujos,
  };
  const unaVez = valores["una-vez"] === true;
  if (unaVez) {
    // n8n o el Programador de tareas lo lanzan muy seguido: si el ciclo no va a correr, sale sin consultar HubSpot.
    const motivo = motivoParaNoCorrer(flujos, arranque.ignorarHorario, Date.now());
    if (motivo) {
      console.log(`Sin consultar HubSpot · ciclo omitido: ${motivo}`);
      return 0;
    }
  }
  try {
    tomarCandado();
  } catch (error) {
    if (unaVez && error instanceof ErrorOcupado) {
      // Un disparo que llega mientras el anterior sigue escribiendo no es un error: ese ciclo ya está atendiendo la cola.
      if (error.minutos < MAX_MIN_OCUPADO) {
        console.log(`Otra ejecución (PID ${error.pid}) sigue en curso; este disparo no hace nada.`);
        return 0;
      }
      throw new ErrorUso(`${error.message} Lleva ${MAX_MIN_OCUPADO} min o más: o ese proceso está colgado, o el modo continuo corre a la vez que n8n.`);
    }
    throw error;
  }
  const contextos = await prepararContextos(arranque, !unaVez);

  const aviso = arranque.modo === "activo" ? `ESCRIBE en HubSpot (${entorno})` : "SOMBRA: decide y registra, NO escribe en HubSpot";
  console.log(`\nAsignación equilibrada ${VERSION_MOTOR} · ${aviso}`);
  for (const ctx of contextos) console.log(`${ctx.flujo.nombre}: ${ctx.pool.map((a) => a.etiqueta).join(", ")}`);
  console.log(unaVez ? "Un solo ciclo.\n" : `Un ciclo cada ${INTERVALO_MS / 60_000} min, de 7:30 a 4:30 (Ctrl+C para salir).\n`);

  if (unaVez) {
    const ahora = Date.now();
    let fallo = false;
    for (const ctx of contextos) {
      try {
        const resumen = await ejecutarCiclo(ctx, ahora);
        if (resumen.omitido) console.log(`${ctx.flujo.nombre}: ciclo omitido: ${resumen.omitido}`);
        else console.log(`[${horaLocal(ahora)}] ${ctx.flujo.nombre}: ${textoResumen(resumen, arranque.modo)}`);
      } catch (error) {
        // Un flujo con problemas no frena al otro; el código de salida avisa al Programador de tareas.
        if (esFatal(error)) throw error;
        alerta(ctx.flujo, "error_ciclo", mensajeDe(error));
        fallo = true;
      }
    }
    return fallo ? 1 : 0;
  }
  await bucle(arranque, contextos);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (codigo) => {
      process.exitCode = codigo;
    },
    (error: unknown) => {
      if (error instanceof ErrorUso || error instanceof ErrorHubSpot) console.error(`\n${error.message}`);
      else console.error(error);
      process.exitCode = error instanceof ErrorUso ? 2 : 1;
    },
  );
}
