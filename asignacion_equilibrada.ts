/**
 * Asignación automática y equilibrada en HubSpot: análisis de riesgo y contratos.
 *
 * Plan:    C:\Temp\Plan_Asignacion_Equilibrada_Analisis_Riesgo.md (v4)
 * Anexo:   C:\Temp\Plan_Asignacion_Equilibrada_Analisis_Riesgo_detalle.md (datos y simulaciones)
 * Reglas:  "Reglas de asignación — Análisis de riesgo y Contratos" (Duvan, 16-nov-2026)
 *
 * Qué hace: de 7:30 a 4:30 reparte los registros que esperan responsable en dos flujos (ver FLUJOS):
 *   analisis_riesgo  objeto "Análisis de riesgo": de "Asignacion de analista" y de "Aplazado" (solo lo que aplazó el
 *                    motor), siempre sin propietario, a "Analista asignado y en tramite". Lo de más de 10 millones
 *                    (canon + administración de la Radicación, a la que se llega por la Solicitud asociada) y lo de
 *                    corredores va directo a la coordinadora de data/analisis_riesgo/reglas.json, aunque esté
 *                    ausente; lo demás se reparte entre los analistas del reparto.
 *   contratos        objeto "Contratos": de "Asignación de ejecutivo" (traiga o no propietario) a "Consolidación de
 *                    información". Decide primero la tabla de Ana (clave del asesor → ejecutivo), luego la lista de
 *                    propietarios con ejecutivo fijo (cédulas de los contactos "Arrendador Cto"), luego las claves
 *                    compartidas; lo demás se reparte entre los ejecutivos de directos. La carga de cada ejecutivo son
 *                    sus contratos abiertos en ese momento. Si el contrato traía otro ejecutivo, tarea para Ana Tavera.
 * El reparto es una regla greedy de costo marginal (casos y monto). Pone a la persona como propietaria y mueve el
 * registro de etapa. Solo escribe en HubSpot (y, en contratos, tareas a coordinación por reasignaciones y por lo que no
 * se asigna a tiempo).
 *
 * Uso (Node 24, sin dependencias):
 *   node asignacion_equilibrada.ts                  ciclo continuo cada 2 min en MODO SOMBRA (decide y registra, no escribe)
 *   node asignacion_equilibrada.ts --activar        igual, pero escribe en HubSpot
 *   node asignacion_equilibrada.ts --una-vez        un solo ciclo y termina (para n8n o el Programador de tareas). Fuera de
 *                                                   horario, en pausa o con otra ejecución en curso sale con 0 sin tocar HubSpot
 *   node asignacion_equilibrada.ts --diagnostico    revisa token, scopes, objetos, etapas, propiedades, reglas y propietarios
 *   node asignacion_equilibrada.ts --parametros     recalcula data/<flujo>/parametros.json desde AGSSA (--desde y --hasta opcionales)
 *   node asignacion_equilibrada.ts --importar-asesores <archivo.xlsx|.csv>
 *                                                   convierte el Excel de Ana en data/contratos/asesores.json
 *   node asignacion_equilibrada.ts --autoprueba     pruebas del motor y de las reglas (no toca HubSpot ni AGSSA)
 *   Extras: --flujo analisis_riesgo|contratos (solo ese flujo; por defecto, los dos), --produccion (usa HUBSPOT_TOKEN
 *   en vez de HUBSPOT_TOKEN_SANDBOX) y --ignorar-horario (pruebas).
 *
 * Archivos (junto a este script):
 *   .env                              HUBSPOT_TOKEN_SANDBOX y HUBSPOT_TOKEN
 *   data/<flujo>/nomina.json          persona ↔ documento AGSSA ↔ propietario de HubSpot ↔ rol ↔ si entra al reparto
 *   data/<flujo>/parametros.json      pesos por rol, monto típico y techos (se genera con --parametros)
 *   data/<flujo>/reglas.json          las reglas de negocio del flujo (asignación directa, claves compartidas, tareas)
 *   data/contratos/asesores.json      clave del asesor → ejecutivo (se genera con --importar-asesores)
 *   data/contratos/propietarios.json  cédula del propietario → ejecutivo fijo (lista del correo de Ana; no va a git)
 *   data/<flujo>/PAUSA                si existe, ese flujo no asigna nada
 *   data/ausencias.json               días laborales, festivos y ausencias de los dos equipos (lo mantiene coordinación)
 *   data/PAUSA                        si existe, no se asigna nada en ningún flujo (interruptor de apagado)
 *   logs/decisiones.jsonl             una línea por decisión, alerta, espera, tarea u omisión, con su flujo
 *   logs/revertidas.jsonl             lo que deshizo revertir_asignacion.ts (fase de pruebas)
 *
 * En HubSpot, cada objeto necesita su propiedad de fecha de asignación ("Fecha y hora") y asignacion_detalle ("Texto de
 * varias líneas"): analisis_fechaasignacionanalisis en Análisis de riesgo y contrato_fechaasignacioncontrato en
 * Contratos (las fechas oficiales). Contratos usa además contrato_ejecutivo_anterior, contrato_reasignaciones y
 * contrato_fecha_ultima_reasignacion, y lee el Asesor y los contactos asociados.
 * Scopes de la app privada: crm.objects.custom.read y .write, crm.schemas.custom.read, crm.objects.owners.read,
 * crm.objects.deals.read (el monto de Análisis está en la Radicación), crm.objects.contacts.read (las cédulas de los
 * arrendadores) y el de escritura de tareas.
 * Las rutas son las de la versión 2026-09 de la API (v3 se apaga en septiembre de 2027).
 *
 * Variable opcional: HUBSPOT_<FLUJO>_OBJETO (FLUJO = ANALISIS_RIESGO o CONTRATOS) fija el objeto que el diagnóstico
 * descubre por nombre. Las pipelines y etapas son las mismas en el sandbox y en producción y están en FLUJOS.
 *
 * Modo sombra: decide exactamente como si escribiera, pero solo anota. Como no saca los registros de la cola, no
 * vuelve a decidir uno que ya decidió dentro de la ventana de los saldos. Sus saldos tienen en cuenta sus decisiones
 * anteriores del log. En modo activo los saldos salen solo de HubSpot.
 *
 * Reversión (fase de pruebas): en modo activo, cada decisión guarda en el log lo que el registro tenía antes de
 * escribirlo. Con eso, node revertir_asignacion.ts lo devuelve a como estaba (ver ese archivo).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

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

/** Versión de las rutas de la API de HubSpot. Desde el 14-nov-2026 el código nuevo usa 2026-09. */
export const API = "2026-09";
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
const VERSION_MOTOR = "v2";
const HASTA_NUEVO_AVISO = "9999-12-31";
const ESCRITURA_SOMBRA = "sombra";
/** Contratos: de dónde salen la clave del asesor y la cédula del propietario (T_OrdenContrato de AGSSA). */
export const PROP_CLAVE_ASESOR = "contrato_orden_claveasesorw";
export const PROP_CEDULA_PROPIETARIO = "contrato_orden_numdocpropw";
/** Contratos: si el contrato no trae la clave, sale del Asesor asociado (el objeto se descubre por su nombre). */
export const ASESOR = { nombres: ["asesor", "asesores"], propiedad: "asesor_clave" };
/** Contratos: los propietarios son los contactos asociados con esta etiqueta; su documento, la primera propiedad con dato. */
export const ETIQUETA_ARRENDADOR = "Arrendador Cto";
export const PROPS_DOCUMENTO_CONTACTO = ["contacto_id_numero_documento", "documento", "documento_propietario"];

// ═════════════════════════════════════════════════════════════════════════════
// 2. TIPOS Y FLUJOS
// ═════════════════════════════════════════════════════════════════════════════

/** Rol dentro del equipo de un flujo: "analista" y "coordinador" en análisis de riesgo, "ejecutivo" y "coordinador" en contratos. */
export type Rol = string;
export type Modo = "sombra" | "activo";
export type Entorno = "sandbox" | "produccion";
export type Propiedades = Record<string, string | null | undefined>;

export interface Persona {
  /** Identificador corto y estable (minúsculas, números y guion bajo). */
  clave: string;
  /** Cómo se ve en consola, logs y asignacion_detalle. */
  etiqueta: string;
  /** Nombre completo; sirve para cruzar con los propietarios de HubSpot y con el Excel de Ana. */
  nombre: string;
  rol: Rol;
  /** T_Usuarios.Documento: el T_Analisis.UsuAnalista o el T_Contratos.UsuEjecutivo de AGSSA. null si no está en AGSSA. */
  documento: string | null;
  /** hubspot_owner_id. Si es null se busca por correo o por nombre. */
  ownerId: string | null;
  correo: string | null;
  activo: boolean;
  /** false: no entra al reparto del algoritmo; solo recibe lo que una regla le manda directo. */
  reparto: boolean;
}

export interface Parametros {
  generado: string;
  calibradoCon: { desde: string; hasta: string; casos: number };
  /** m̄: monto típico, en pesos. */
  canonTipico: number;
  /** c = capacidad en casos y s = cuota de monto, por rol. */
  roles: Record<Rol, { c: number; s: number }>;
  /** T_j: techo duro de monto por persona (P99 de lo que ha manejado), en pesos. Solo cuenta si el flujo usa techo. */
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

/**
 * Carga por historial: e_j = casos recibidos menos los que le correspondían y E_j = monto recibido menos el que le
 * correspondía (en montos típicos). Carga en tiempo real: e_j = registros abiertos y E_j = su monto (en montos típicos).
 */
export interface Estado {
  e: Record<string, number>;
  E: Record<string, number>;
}

export interface Evento {
  id: string;
  /** Cuándo se asignó (milisegundos). -Infinity si no se sabe. */
  instante: number;
  clave: string;
  monto: number | null;
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
  properties: Propiedades;
}

interface PaginaHS {
  results: RegistroHS[];
  paging?: { next?: { after: string } };
}

export interface ClienteHS {
  solicitar<T>(metodo: "GET" | "POST" | "PATCH", ruta: string, cuerpo?: unknown): Promise<T>;
}

/** Una etapa de origen. Un registro entra a la cola si está en esa etapa y cumple sus filtros (todos por igualdad). */
export interface Cola {
  etapa: string;
  nombre: string;
  filtros?: { propiedad: string; valor: string }[];
}

/** El monto que pesa en el reparto: de qué objeto se lee (el registro o un objeto asociado) y cómo se calcula. */
export interface Monto {
  /** Tipo del objeto asociado que tiene el monto (p. ej. "0-3", negocios). Sin él, se lee del registro. */
  asociado?: string;
  /**
   * Del objeto asociado, el de esta pipeline (y su nombre, para los mensajes). Si el registro no lo tiene asociado
   * directamente, se busca entre los asociados de sus asociados del mismo tipo (la Solicitud → la Radicación).
   */
  pipeline?: { id: string; nombre: string };
  propiedades: string[];
  calcular: (p: Propiedades) => number | null;
  descripcion: string;
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
  /** Pipeline, etapas de origen y etapa de destino. Los IDs son los mismos en el sandbox y en producción. */
  pipeline: string;
  colas: Cola[];
  destino: { etapa: string; nombre: string };
  /** true: la cola son solo los registros sin propietario. false: el propietario que traiga se reemplaza. */
  colaSinPropietario: boolean;
  /** Roles válidos en la nómina del flujo. */
  roles: Rol[];
  /** Propiedad de fecha y hora donde queda la asignación (y de la que sale el historial). */
  propFecha: string;
  /**
   * Cómo se mide la carga de cada uno: "historial" (lo asignado en los últimos 30 días hábiles, con olvido) o
   * "abiertos" (los registros que tiene en etapas de trabajo en ese momento).
   */
  carga: "historial" | "abiertos";
  /** Si aplica el techo duro de monto por persona de parametros.json. */
  conTecho: boolean;
  monto: Monto;
  /** Propiedades del registro que leen las reglas del flujo. */
  leer: string[];
  /** Contratos: lo que se escribe cuando el registro ya tenía otro ejecutivo. */
  reasignacion?: { anterior: string; contador: string; fecha: string };
  /** Consultas a AGSSA para --parametros (cada caso: id, fecha de asignación, documento de quien lo recibió y monto). */
  agssa: { ultimaFecha: string; casos: (documentos: string, desde: string, hasta: string) => string };
}

/** Análisis de riesgo: canon + administración del negocio. Las radicaciones nuevas traen los dos; las anteriores, el total. */
export function montoAnalisis(p: Propiedades): number | null {
  const canon = parsearCanon(p.radicacion_canon);
  if (canon !== null) return canon + (parsearCanon(p.radicacion_administracion) ?? 0);
  return parsearCanon(p.valor_canon___admon);
}

export const FLUJOS: readonly Flujo[] = [
  {
    clave: "analisis_riesgo",
    nombre: "Análisis de riesgo",
    persona: "analista",
    personas: "analistas",
    esObjeto: (etiqueta) => etiqueta.includes("analisis de riesgo"),
    pipeline: "935982430",
    colas: [
      { etapa: "1439946540", nombre: "Asignacion de analista" },
      // Solo lo que aplazó el motor: los aplazados que llegaron de AGSSA en la migración no tienen resultado del motor.
      { etapa: "1439946543", nombre: "Aplazado", filtros: [{ propiedad: "analisis_resultado_motor", valor: "Aplazado" }] },
    ],
    destino: { etapa: "1439946541", nombre: "Analista asignado y en tramite" },
    colaSinPropietario: true,
    roles: ["analista", "coordinador"],
    // La fecha oficial (T_Analisis.FechaAsignacionAnalisis). Hasta el 16-nov el script escribía fecha_asignacion_analista.
    propFecha: "analisis_fechaasignacionanalisis",
    carga: "historial",
    // Con el P99, todo caso de 6 a 10 millones caería siempre en la misma persona; lo de más de 10 va directo (reglas.json).
    conTecho: false,
    // El Análisis queda asociado a la Solicitud (pipeline 935814405), que no trae el canon; el canon está en la
    // Radicación (pipeline 935981686) asociada a esa Solicitud.
    monto: {
      asociado: "0-3",
      pipeline: { id: "935981686", nombre: "Radicación" },
      propiedades: ["radicacion_canon", "radicacion_administracion", "valor_canon___admon"],
      calcular: montoAnalisis,
      descripcion: "canon + administración",
    },
    leer: [],
    agssa: {
      ultimaFecha: "SELECT CONVERT(varchar(10), MAX(FechaAsignacionAnalisis), 120) FROM T_Analisis",
      casos: (documentos, desde, hasta) =>
        "SELECT a.IdAnalisis, CONVERT(varchar(19), a.FechaAsignacionAnalisis, 126), a.UsuAnalista, CONVERT(varchar(30), CAST(i.CanonArrendamiento + ISNULL(i.CuotaAdmon, 0) AS decimal(18,2))) " +
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
    pipeline: "953891442",
    colas: [{ etapa: "1472969116", nombre: "Asignación de ejecutivo" }],
    destino: { etapa: "1472969117", nombre: "Consolidación de información" },
    colaSinPropietario: false,
    roles: ["ejecutivo", "coordinador"],
    propFecha: "contrato_fechaasignacioncontrato",
    carga: "abiertos",
    // La tabla de Ana manda casi todo a un ejecutivo fijo sin mirar el canon; un techo solo afectaría al resto.
    conTecho: false,
    monto: { propiedades: ["contrato_canon"], calcular: (p) => parsearCanon(p.contrato_canon), descripcion: "canon" },
    leer: [PROP_CLAVE_ASESOR, PROP_CEDULA_PROPIETARIO, "contrato_reasignaciones"],
    reasignacion: { anterior: "contrato_ejecutivo_anterior", contador: "contrato_reasignaciones", fecha: "contrato_fecha_ultima_reasignacion" },
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
  etapasCola: string[];
  etapaDestino: string;
  /** Etapas abiertas después de la cola: la carga en tiempo real. */
  etapasAbiertas: string[];
  /** ownerId de HubSpot → clave de la nómina. */
  claveDeOwner: Map<string, string>;
  /** clave de la nómina → ownerId de HubSpot. */
  ownerDeClave: Map<string, string>;
  /** Contratos: los ownerIds que acepta contrato_ejecutivo_anterior (es una lista de opciones). */
  opcionesAnterior: Set<string> | null;
  /** ownerId → nombre en HubSpot (todos los propietarios, para nombrar al ejecutivo anterior en las tareas). */
  nombreDeOwner: Map<string, string>;
  /** Contratos: a quién se le crea la tarea si un registro no se asigna a tiempo, y cómo se asocia la tarea. */
  tarea: TareaHS | null;
  /** Contratos: a quién se le crea la tarea cuando el contrato traía otro ejecutivo. */
  tareaReasignacion: TareaHS | null;
  /** Contratos: el objeto Asesor y su propiedad de clave, o null si no se encontró (solo cuenta la propiedad del contrato). */
  asesor: { objeto: string; propiedad: string } | null;
  /** Contratos: el tipo de asociación contrato → contacto "Arrendador Cto", o null si no existe. */
  arrendador: { typeId: number } | null;
}

export interface TareaHS {
  owners: { nombre: string; id: string }[];
  asociacion: { associationCategory: string; associationTypeId: number };
}

/** Análisis de riesgo: lo que va directo a una persona (aunque esté ausente), sin pasar por el reparto. */
export interface ReglasAnalisis {
  tipo: "analisis_riesgo";
  directo: { persona: string; montoMayorA: number; condiciones: { propiedad: string; valor: string; motivo: string }[] } | null;
}

/** Contratos: de qué depende el ejecutivo de un contrato (en el orden en que se aplica). */
export interface ReglasContratos {
  tipo: "contratos";
  /** Clave de asesor (normalizada) → ejecutivos, de la tabla de Ana. */
  asesores: Map<string, string[]>;
  tabla: { claves: number; fuente: string | null; importado: string | null };
  /** Claves que se reparten entre varios ejecutivos (mandan sobre la tabla). */
  compartidas: Map<string, string[]>;
  /** Cédula del propietario (en sus variantes normalizadas) → ejecutivo fijo. */
  propietarios: Map<string, string>;
  /** Cuántas cédulas tiene la lista (sin contar variantes). */
  totalPropietarios: number;
  /** Los ejecutivos de directos: reciben lo que no tiene ejecutivo por regla y lo de un ejecutivo ausente. */
  directos: string[];
  tarea: { minutos: number; responsables: string[] } | null;
  tareaReasignacion: { responsables: string[] } | null;
}

/** Contratos: lo que las reglas leen del contrato y de sus asociados (el Asesor y los contactos "Arrendador Cto"). */
export interface DatosContrato {
  /** Clave del asesor (normalizada): la del contrato o, si no la trae, la del Asesor asociado. "" si no hay. */
  clave: string;
  /** Documentos de los arrendadores y del propietario de la orden, en sus variantes normalizadas. */
  cedulas: string[];
}

export type Reglas = ReglasAnalisis | ReglasContratos;

export interface Contexto {
  flujo: Flujo;
  modo: Modo;
  entorno: Entorno;
  hs: ClienteHS;
  cfg: ConfigHS;
  /** La nómina activa (entra o no al reparto). */
  pool: Persona[];
  params: Parametros;
  reglas: Reglas;
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
  /** Registros que ninguna regla pudo asignar (quedan en la cola). */
  enEspera: number;
}

interface DecisionLog {
  tipo: string;
  fecha: string;
  flujo: string;
  modo: Modo;
  entorno: Entorno;
  id: string;
  monto?: number | null;
  /** Las decisiones anteriores al motor v2 guardaban el canon con este nombre. */
  canon?: number | null;
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
const unicos = (lista: string[]) => [...new Set(lista)];
const enLotes = <T>(lista: T[], n: number): T[][] => Array.from({ length: Math.ceil(lista.length / n) }, (_, i) => lista.slice(i * n, i * n + n));

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

/** Clave de asesor o cédula: solo letras y números, sin ceros a la izquierda ("1.020.304" → "1020304"). "" si no hay. */
export function normalizarCodigo(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  let texto = String(valor).trim();
  if (/^\d+\.0$/.test(texto)) texto = texto.slice(0, -2); // 44476.0, como lo exportan algunas hojas de cálculo
  texto = texto.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return /^\d+$/.test(texto) ? texto.replace(/^0+(?=\d)/, "") : texto;
}

/** Monto válido (> 0) o null. Un valor vacío o ilegible se trata como "sin dato". */
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

/** Día laboral = día de la semana laboral y sin una ausencia de "*" (festivo). */
export const esDiaLaboral = (fecha: string, cal: Calendario): boolean =>
  cal.diasLaborales.includes(diaSemana(fecha)) && !cal.ausencias.some((a) => a.persona === "*" && cubre(a, fecha));

/**
 * Quiénes están ese día: la nómina activa sin los ausentes. Un día no laboral no tiene presentes, salvo con
 * ignorarDiaLaboral (--ignorar-horario, pruebas): entonces el festivo (ausencia de "*") no cuenta, pero las ausencias
 * de cada persona sí.
 */
export function presentesEn(fecha: string, pool: Persona[], cal: Calendario, ignorarDiaLaboral = false): Persona[] {
  if (!ignorarDiaLaboral && !esDiaLaboral(fecha, cal)) return [];
  // Si el día era festivo, ya se descartó arriba o se pidió ignorarlo: aquí solo cuentan las ausencias personales.
  return pool.filter((a) => !cal.ausencias.some((x) => x.persona === a.clave && cubre(x, fecha)));
}

/** Los que entran al reparto del algoritmo (los demás solo reciben por regla). */
export const competidoresDe = (personas: Persona[]): Persona[] => personas.filter((a) => a.reparto);

/** Quién recibe qué, en una línea (consola y diagnóstico). */
function resumenEquipo(pool: Persona[], reglas: Reglas, personas: string): string {
  const nombres = (lista: Persona[]) => lista.map((a) => a.etiqueta).join(", ") || "nadie";
  if (reglas.tipo === "contratos") {
    const directos = pool.filter((a) => reglas.directos.includes(a.clave));
    const otros = pool.filter((a) => !reglas.directos.includes(a.clave));
    return `${directos.length} ${personas} de directos (${nombres(directos)}); los demás reciben solo por su clave de asesor o su propietario: ${nombres(otros)}`;
  }
  const soloRegla = pool.filter((a) => !a.reparto);
  return `reparto entre ${nombres(competidoresDe(pool))}${soloRegla.length ? `; reciben solo por regla: ${nombres(soloRegla)}` : ""}`;
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

/** Las líneas del log de esos tipos desde `desdeMs`. */
function leerLog(desdeMs: number, tipos: string[]): Record<string, unknown>[] {
  if (!existsSync(RUTA.log)) return [];
  const salida: Record<string, unknown>[] = [];
  for (const linea of readFileSync(RUTA.log, "utf8").split("\n")) {
    if (!linea) continue;
    try {
      const l = JSON.parse(linea) as Record<string, unknown>;
      if (tipos.includes(String(l.tipo)) && Date.parse(String(l.fecha)) >= desdeMs) salida.push(l);
    } catch {
      // Línea dañada (p. ej. corte de energía a mitad de escritura): se ignora.
    }
  }
  return salida;
}

/** Las líneas de un tipo de este flujo, en este modo y este entorno, desde `desdeMs`. */
function lineasDelFlujo(ctx: Pick<Contexto, "flujo" | "modo" | "entorno">, tipo: string, desdeMs: number): Record<string, unknown>[] {
  return leerLog(desdeMs, [tipo]).filter((l) => l.flujo === ctx.flujo.clave && l.modo === ctx.modo && l.entorno === ctx.entorno);
}

const decisionesDelFlujo = (ctx: Pick<Contexto, "flujo" | "modo" | "entorno">, desdeMs: number): DecisionLog[] =>
  lineasDelFlujo(ctx, "decision", desdeMs) as unknown as DecisionLog[];

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

/** w: el caso en montos típicos. Sin monto cuenta como un caso típico (w = 1). */
export const pesoDeCaso = (monto: number | null, p: Parametros): number => (monto ?? p.canonTipico) / p.canonTipico;

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

export interface OpcionesReparto {
  /** true (por defecto): la llegada del caso sube la meta de los presentes (carga por historial). false: Δ sobre la carga actual. */
  subirMeta?: boolean;
  /** true (por defecto): solo compiten quienes tienen techo para el monto. Sin techo en parametros.json no hay límite. */
  techo?: boolean;
  /** Instante de la última asignación de cada uno: en empate gana quien lleva más tiempo sin recibir. */
  ultimoRecibo?: Record<string, number>;
}

/**
 * Reparte un caso entre los presentes y actualiza el estado (pasos 1 a 4 del plan).
 * `presentes` debe venir en el orden de la nómina: es el último criterio de desempate.
 */
export function asignarCaso(estado: Estado, presentes: Persona[], canon: number | null, p: Parametros, op: OpcionesReparto = {}): Decision {
  if (!presentes.length) throw new Error("asignarCaso: no hay nadie presente");
  const sinCanon = canon === null;
  const m = canon ?? p.canonTipico;
  const w = m / p.canonTipico;

  if (op.subirMeta !== false) subirMeta(estado, presentes, w, p);

  // Paso 2: solo compiten los que tienen techo para este monto; si nadie lo tiene, el de mayor techo.
  const techo = (a: Persona) => p.techos[a.clave] ?? Infinity;
  let elegibles = op.techo === false ? presentes : presentes.filter((a) => m <= techo(a));
  const respaldo = elegibles.length === 0;
  if (respaldo) elegibles = [presentes.reduce((mejor, a) => (techo(a) > techo(mejor) ? a : mejor))];

  const candidatos: Candidato[] = elegibles.map((a) => ({
    clave: a.clave,
    delta: costoMarginal(estado, a, w, p),
    e: estado.e[a.clave],
    E: estado.E[a.clave],
  }));

  // Paso 4: gana el menor Δ; en empate, quien lleva más tiempo sin recibir (si se sabe), luego el de menor e_j y
  // luego el orden de la nómina.
  const ultimo = (k: string) => op.ultimoRecibo?.[k] ?? -Infinity;
  let elegido = candidatos[0];
  for (const c of candidatos.slice(1)) {
    const diferencia = c.delta - elegido.delta;
    if (diferencia < -EPS) elegido = c;
    else if (Math.abs(diferencia) <= EPS) {
      if (op.ultimoRecibo && ultimo(c.clave) !== ultimo(elegido.clave)) {
        if (ultimo(c.clave) < ultimo(elegido.clave)) elegido = c;
      } else if (c.e < elegido.e - EPS) elegido = c;
    }
  }

  registrarAsignacion(estado, elegido.clave, w);
  return { elegido: elegido.clave, candidatos, w, sinCanon, respaldo };
}

/**
 * Carga por historial: reconstruye e_j y E_j repitiendo, día a día, lo que hizo el reparto: la memoria al empezar
 * cada día hábil y, por cada asignación, la subida de meta de los presentes más el caso recibido.
 * Los presentes de un día son la nómina menos los ausentes, más quien haya recibido casos ese día.
 */
export function reconstruirEstado(eventos: Evento[], hoy: string, pool: Persona[], cal: Calendario, p: Parametros): Estado {
  const estado = estadoVacio(pool.map((a) => a.clave));
  const claves = new Set(pool.map((a) => a.clave));
  const validos = eventos
    .filter((ev) => claves.has(ev.clave) && Number.isFinite(ev.instante) && fechaBogota(ev.instante) <= hoy)
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
      const w = pesoDeCaso(ev.monto, p);
      subirMeta(estado, presentes, w, p);
      registrarAsignacion(estado, ev.clave, w);
    }
  }
  return estado;
}

/**
 * Carga en tiempo real: cuántos registros abiertos tiene cada uno y cuánto monto suman (en montos típicos), y cuándo
 * recibió el último. Lo legalizado, lo caído y lo reasignado a otro ya no está entre los abiertos.
 */
export function estadoDeCarga(abiertos: Evento[], claves: string[], p: Parametros): { estado: Estado; ultimoRecibo: Record<string, number> } {
  const estado = estadoVacio(claves);
  const ultimoRecibo: Record<string, number> = {};
  for (const ev of abiertos) {
    if (!(ev.clave in estado.e)) continue;
    registrarAsignacion(estado, ev.clave, pesoDeCaso(ev.monto, p));
    if (ev.instante > (ultimoRecibo[ev.clave] ?? -Infinity)) ultimoRecibo[ev.clave] = ev.instante;
  }
  return { estado, ultimoRecibo };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. REGLAS DE NEGOCIO (funciones puras: a quién le toca cada registro)
// ═════════════════════════════════════════════════════════════════════════════

/** Todo lo que necesita una regla para decidir, menos el registro. */
export interface Reparto {
  /** La nómina activa, con los ausentes: una regla puede mandarle a alguien aunque hoy no esté. */
  activos: Persona[];
  /** La nómina activa sin los ausentes, en el orden de la nómina (incluye a quien recibe solo por regla). */
  presentes: Persona[];
  /** Los presentes que entran al reparto. */
  competidores: Persona[];
  estado: Estado;
  params: Parametros;
  opciones: OpcionesReparto;
  /** Cómo se llama una persona en los mensajes. */
  nombres: (clave: string) => string;
}

export interface Destino {
  /** Quién lo recibe, o null si el registro se queda esperando en la cola. */
  clave: string | null;
  /** Por qué: queda en el log y en asignacion_detalle. */
  regla: string;
  /** La decisión del algoritmo, si la hubo (null: lo decidió una regla directa). */
  decision: Decision | null;
}

const estaPresente = (r: Reparto, clave: string | null): boolean => clave !== null && r.presentes.some((a) => a.clave === clave);

function repartir(r: Reparto, entre: Persona[], monto: number | null, regla: string): Destino {
  if (!entre.length) return { clave: null, regla: `${regla}: no hay nadie del reparto presente`, decision: null };
  const decision = asignarCaso(r.estado, entre, monto, r.params, r.opciones);
  return { clave: decision.elegido, regla, decision };
}

/**
 * Análisis de riesgo: lo de más de `montoMayorA` (canon + administración) o lo que cumple una condición (negocio de
 * corredores) va directo a la persona de la regla, siempre, aunque esté ausente (reglas del 16-nov). Solo espera en la
 * cola si esa persona no está activa en la nómina. Lo demás se reparte entre los del reparto.
 */
export function destinoAnalisis(reglas: ReglasAnalisis, props: Propiedades, monto: number | null, r: Reparto): Destino {
  const d = reglas.directo;
  if (d) {
    const condicion = d.condiciones.find((c) => normalizar(String(props[c.propiedad] ?? "")) === normalizar(c.valor));
    const motivo = monto !== null && monto > d.montoMayorA ? `monto mayor que ${cop(d.montoMayorA)}` : condicion?.motivo;
    if (motivo) {
      if (!r.activos.some((a) => a.clave === d.persona)) {
        return { clave: null, regla: `${motivo}: va directo a ${r.nombres(d.persona)}, que no está activa en la nómina`, decision: null };
      }
      const nota = estaPresente(r, d.persona) ? "" : " (aunque hoy figura ausente)";
      return { clave: d.persona, regla: `directo a ${r.nombres(d.persona)}${nota}: ${motivo}`, decision: null };
    }
  }
  return repartir(r, r.competidores, monto, "reparto");
}

/**
 * Una cédula o NIT en las formas en que se compara con la lista de propietarios: normalizada, sin un prefijo de letras
 * ("CC 1.020.304", "NIT: 900…") y sin el dígito de verificación ("900.123.456-7"). [] si no hay dato.
 */
export function variantesDocumento(valor: unknown): string[] {
  const texto = valor === null || valor === undefined ? "" : String(valor).trim();
  const variantes = [normalizarCodigo(texto)];
  const sinPrefijo = texto.replace(/^[A-Za-z][A-Za-z.\s]*?[\s.:]+(?=\d)/, "");
  if (sinPrefijo !== texto) variantes.push(normalizarCodigo(sinPrefijo));
  const sinDigito = /^([\d.\s]+)-\s*\d$/.exec(sinPrefijo);
  if (sinDigito) variantes.push(normalizarCodigo(sinDigito[1]));
  return unicos(variantes.filter(Boolean));
}

/**
 * Lo que leen las reglas de un contrato: la clave del asesor (la del contrato o, si no la trae, la del Asesor asociado)
 * y los documentos de los arrendadores asociados, más el del propietario en la orden si lo trae.
 */
export function datosContrato(props: Propiedades, asociados: { claves: string[]; documentos: string[] } = { claves: [], documentos: [] }): DatosContrato {
  const clave = normalizarCodigo(props[PROP_CLAVE_ASESOR]) || asociados.claves.map(normalizarCodigo).find(Boolean) || "";
  const cedulas = unicos([...asociados.documentos, props[PROP_CEDULA_PROPIETARIO] ?? ""].flatMap(variantesDocumento));
  return { clave, cedulas };
}

/**
 * Contratos, en este orden (reglas del 16-nov):
 *   1. La clave del asesor tiene un solo ejecutivo en la tabla de Ana (incluidas las de Ana Tavera): ese ejecutivo.
 *   2. Si no, alguno de los arrendadores tiene ejecutivo fijo (correo de Ana): ese ejecutivo.
 *   3. Si no, la clave es compartida: reparto solo entre sus ejecutivos presentes.
 *   4. Sin asesor o con una clave fuera de la tabla: reparto entre los ejecutivos de directos presentes.
 *   5. Si el ejecutivo que corresponde no está (o ninguno de la clave compartida): reparto entre los de directos presentes.
 * Si tampoco hay nadie de directos, el contrato espera en la cola (y a los 3 minutos, tarea a coordinación).
 */
export function destinoContrato(reglas: ReglasContratos, datos: DatosContrato, monto: number | null, r: Reparto): Destino {
  const { clave } = datos;
  const deClave = clave ? (reglas.compartidas.get(clave) ?? reglas.asesores.get(clave)) : undefined;
  const presentesDe = (grupo: string[]) => r.presentes.filter((a) => grupo.includes(a.clave));

  const aDirectos = (motivo: string): Destino => {
    const entre = presentesDe(reglas.directos);
    if (!entre.length) return { clave: null, regla: `${motivo}; no hay ningún ejecutivo de directos presente`, decision: null };
    return repartir(r, entre, monto, `${motivo}: reparto entre los ejecutivos de directos presentes`);
  };
  const fijo = (ejecutivo: string, origen: string): Destino =>
    estaPresente(r, ejecutivo) ? { clave: ejecutivo, regla: origen, decision: null } : aDirectos(`${origen}, que no está`);

  if (deClave?.length === 1) return fijo(deClave[0], `clave de asesor ${clave} → ${r.nombres(deClave[0])} (ejecutivo único)`);
  const cedula = datos.cedulas.find((c) => reglas.propietarios.has(c));
  if (cedula) {
    const ejecutivo = reglas.propietarios.get(cedula)!;
    return fijo(ejecutivo, `propietario con ejecutivo fijo → ${r.nombres(ejecutivo)}`);
  }
  if (deClave && deClave.length > 1) {
    const entre = presentesDe(deClave);
    if (entre.length) return repartir(r, entre, monto, `clave compartida ${clave}: reparto entre ${entre.map((a) => a.etiqueta).join(", ")}`);
    return aDirectos(`clave compartida ${clave}, sin ninguno de sus ejecutivos presente`);
  }
  return aDirectos(clave ? `clave de asesor ${clave} sin ejecutivo en la tabla` : "contrato sin asesor");
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. DATOS LOCALES (nómina, parámetros, ausencias, reglas y tabla de asesores)
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

interface PersonaJSON {
  clave?: string;
  etiqueta?: string;
  nombre?: string;
  rol?: string;
  documento?: string | number | null;
  ownerId?: string | number | null;
  correo?: string | null;
  activo?: boolean;
  reparto?: boolean;
}

/** Valida una nómina ya leída. `origen` es el archivo, para los mensajes. `pool` es la nómina activa. */
export function validarNomina(bruto: { personas?: PersonaJSON[] }, flujo: Flujo, origen: string): { todos: Persona[]; pool: Persona[] } {
  if (!Array.isArray(bruto.personas) || !bruto.personas.length) throw new ErrorUso(`${origen} debe tener una lista 'personas'.`);
  const vistas = new Set<string>();
  const todos = bruto.personas.map((a, i): Persona => {
    const donde = `${origen}, personas[${i}]`;
    if (!a.clave || !/^[a-z0-9_]+$/.test(a.clave)) throw new ErrorUso(`${donde}: 'clave' debe ser minúsculas, números y guion bajo.`);
    if (vistas.has(a.clave)) throw new ErrorUso(`${donde}: la clave '${a.clave}' está repetida.`);
    vistas.add(a.clave);
    if (!a.rol || !flujo.roles.includes(a.rol)) throw new ErrorUso(`${donde}: 'rol' debe ser ${flujo.roles.map((r) => `"${r}"`).join(" o ")}.`);
    if (!a.nombre) throw new ErrorUso(`${donde}: falta 'nombre'.`);
    return {
      clave: a.clave,
      etiqueta: a.etiqueta ?? a.nombre,
      nombre: a.nombre,
      rol: a.rol,
      documento: a.documento === undefined || a.documento === null || a.documento === "" ? null : String(a.documento),
      ownerId: a.ownerId ? String(a.ownerId) : null,
      correo: a.correo ?? null,
      activo: a.activo !== false,
      reparto: a.reparto !== false,
    };
  });
  const pool = todos.filter((a) => a.activo);
  if (!pool.length) throw new ErrorUso(`${origen}: no hay ${flujo.personas} activos.`);
  if (!competidoresDe(pool).length) throw new ErrorUso(`${origen}: ninguno de los ${flujo.personas} activos entra al reparto ('reparto' está en false para todos).`);
  return { todos, pool };
}

export function cargarNomina(flujo: Flujo): { todos: Persona[]; pool: Persona[] } {
  const origen = `data/${flujo.clave}/nomina.json`;
  return validarNomina(leerJSON(rutaFlujo(flujo, "nomina.json"), `la nómina de ${flujo.nombre} (${origen})`), flujo, origen);
}

/** Los parámetros que necesitan los del reparto: el monto típico, los pesos de sus roles y, si el flujo usa techo, el suyo. */
export function cargarParametros(flujo: Flujo, competidores: Persona[]): Parametros {
  const origen = `data/${flujo.clave}/parametros.json`;
  const p = leerJSON<Parametros>(
    rutaFlujo(flujo, "parametros.json"),
    `los parámetros de ${flujo.nombre} (${origen}); se generan con: node asignacion_equilibrada.ts --parametros --flujo ${flujo.clave}`,
  );
  const positivo = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!positivo(p.canonTipico)) throw new ErrorUso(`${origen}: 'canonTipico' debe ser un número mayor que 0.`);
  p.techos ??= {};
  for (const rol of new Set(competidores.map((a) => a.rol))) {
    if (!positivo(p.roles?.[rol]?.c) || !positivo(p.roles?.[rol]?.s)) {
      throw new ErrorUso(`${origen}: faltan los pesos 'c' y 's' del rol ${rol}.`);
    }
  }
  if (flujo.conTecho) {
    for (const a of competidores) {
      if (!positivo(p.techos[a.clave])) {
        throw new ErrorUso(`${origen} no tiene techo para ${a.etiqueta} (${a.clave}); hay que ejecutar --parametros --flujo ${flujo.clave}.`);
      }
    }
  }
  return p;
}

export function cargarCalendario(ruta: string = RUTA.ausencias): Calendario {
  if (!existsSync(ruta)) return { diasLaborales: [1, 2, 3, 4, 5], ausencias: [] };
  return validarCalendario(leerJSON<Partial<Calendario>>(ruta, "las ausencias (data/ausencias.json)"));
}

export function validarCalendario(bruto: Partial<Calendario>): Calendario {
  const dias = bruto.diasLaborales ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(dias) || dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ErrorUso("data/ausencias.json: 'diasLaborales' debe ser una lista de números de 0 (domingo) a 6 (sábado).");
  }
  const formatoFecha = /^\d{4}-\d{2}-\d{2}$/;
  const ausencias = ((bruto.ausencias ?? []) as (Omit<Ausencia, "hasta"> & { hasta: string | null })[]).map((a, i): Ausencia => {
    const donde = `data/ausencias.json, ausencias[${i}]`;
    if (!a.persona) throw new ErrorUso(`${donde}: falta 'persona' (su clave de la nómina, o "*" para todos).`);
    // "hasta": null es "hasta nuevo aviso" (p. ej. vacaciones sin fecha de regreso).
    const hasta = a.hasta === null ? HASTA_NUEVO_AVISO : a.hasta;
    if (!formatoFecha.test(a.desde ?? "") || !formatoFecha.test(hasta ?? "")) throw new ErrorUso(`${donde}: 'desde' y 'hasta' deben ser AAAA-MM-DD ('hasta' puede ser null: hasta nuevo aviso).`);
    if (a.desde > hasta) throw new ErrorUso(`${donde}: 'desde' es posterior a 'hasta'.`);
    return { persona: a.persona, desde: a.desde, hasta, motivo: a.motivo };
  });
  return { diasLaborales: dias, ausencias };
}

// ── Reglas ────────────────────────────────────────────────────────────────────

export interface ReglasAnalisisJSON {
  directo?: { persona?: string; montoMayorA?: number; condiciones?: { propiedad?: string; valor?: string | boolean; motivo?: string }[] } | null;
}
export interface ReglasContratosJSON {
  clavesCompartidas?: Record<string, string[]>;
  directos?: string[];
  tareaSinAsignar?: { minutos?: number; responsables?: string[] } | null;
  tareaReasignacion?: { responsables?: string[] } | null;
}
export interface AsesoresJSON {
  fuente?: string;
  importado?: string;
  claves?: Record<string, string[]>;
}
export interface PropietariosJSON {
  propietarios?: { cedula?: string | number; ejecutivo?: string; nota?: string }[];
}

function exigirPersona(todos: Persona[], clave: unknown, donde: string): string {
  if (typeof clave !== "string" || !todos.some((a) => a.clave === clave)) {
    throw new ErrorUso(`${donde}: '${String(clave)}' no está en la nómina (se usa la clave, p. ej. "${todos[0]?.clave ?? "clave"}").`);
  }
  return clave;
}

export function validarReglasAnalisis(bruto: ReglasAnalisisJSON, todos: Persona[], origen: string): ReglasAnalisis {
  let directo: ReglasAnalisis["directo"] = null;
  if (bruto.directo) {
    const d = bruto.directo;
    const persona = exigirPersona(todos, d.persona, `${origen}, directo.persona`);
    if (typeof d.montoMayorA !== "number" || !(d.montoMayorA > 0)) throw new ErrorUso(`${origen}: 'directo.montoMayorA' debe ser un número mayor que 0 (en pesos).`);
    const condiciones = (d.condiciones ?? []).map((c, i) => {
      if (!c.propiedad || !/^[a-z0-9_]+$/.test(c.propiedad)) throw new ErrorUso(`${origen}, directo.condiciones[${i}]: 'propiedad' debe ser el nombre interno de una propiedad de HubSpot.`);
      if (c.valor === undefined || c.valor === "") throw new ErrorUso(`${origen}, directo.condiciones[${i}]: falta 'valor'.`);
      return { propiedad: c.propiedad, valor: String(c.valor), motivo: c.motivo || `${c.propiedad} = ${String(c.valor)}` };
    });
    directo = { persona, montoMayorA: d.montoMayorA, condiciones };
  }
  return { tipo: "analisis_riesgo", directo };
}

export function validarReglasContratos(
  reglas: ReglasContratosJSON,
  asesores: AsesoresJSON | null,
  propietarios: PropietariosJSON | null,
  todos: Persona[],
): ReglasContratos {
  const listaDe = (valor: unknown, donde: string): string[] => {
    if (!Array.isArray(valor) || !valor.length) throw new ErrorUso(`${donde}: debe ser una lista de claves de la nómina.`);
    return unicos(valor.map((k) => exigirPersona(todos, k, donde)));
  };
  const compartidas = new Map<string, string[]>();
  for (const [clave, lista] of Object.entries(reglas.clavesCompartidas ?? {})) {
    compartidas.set(normalizarCodigo(clave), listaDe(lista, `data/contratos/reglas.json, clavesCompartidas["${clave}"]`));
  }
  const tabla = new Map<string, string[]>();
  for (const [clave, lista] of Object.entries(asesores?.claves ?? {})) {
    tabla.set(normalizarCodigo(clave), listaDe(lista, `data/contratos/asesores.json, claves["${clave}"]`));
  }
  const fijos = new Map<string, string>();
  const vistas = new Map<string, string>();
  for (const [i, p] of (propietarios?.propietarios ?? []).entries()) {
    const donde = `data/contratos/propietarios.json, propietarios[${i}]`;
    const variantes = variantesDocumento(p.cedula);
    if (!variantes.length) throw new ErrorUso(`${donde}: falta 'cedula'.`);
    const ejecutivo = exigirPersona(todos, p.ejecutivo, `${donde}, ejecutivo`);
    if (vistas.has(variantes[0]) && vistas.get(variantes[0]) !== ejecutivo) throw new ErrorUso(`${donde}: esa cédula ya tiene otro ejecutivo fijo.`);
    vistas.set(variantes[0], ejecutivo);
    for (const v of variantes) if (!fijos.has(v)) fijos.set(v, ejecutivo);
  }
  const responsablesDe = (valor: unknown, donde: string): string[] => {
    if (!Array.isArray(valor) || !valor.length || valor.some((x) => typeof x !== "string" || !x.trim())) {
      throw new ErrorUso(`data/contratos/reglas.json: '${donde}' debe ser una lista de nombres (o ownerIds) de HubSpot.`);
    }
    return valor.map((x: string) => x.trim());
  };
  let tarea: ReglasContratos["tarea"] = null;
  if (reglas.tareaSinAsignar) {
    const t = reglas.tareaSinAsignar;
    const minutos = t.minutos ?? 3;
    if (typeof minutos !== "number" || !(minutos > 0)) throw new ErrorUso("data/contratos/reglas.json: 'tareaSinAsignar.minutos' debe ser mayor que 0.");
    tarea = { minutos, responsables: responsablesDe(t.responsables, "tareaSinAsignar.responsables") };
  }
  const tareaReasignacion = reglas.tareaReasignacion ? { responsables: responsablesDe(reglas.tareaReasignacion.responsables, "tareaReasignacion.responsables") } : null;
  return {
    tipo: "contratos",
    asesores: tabla,
    tabla: { claves: tabla.size, fuente: asesores?.fuente ?? null, importado: asesores?.importado ?? null },
    compartidas,
    propietarios: fijos,
    totalPropietarios: vistas.size,
    // Sin 'directos' las reglas cargan (p. ej. al importar la tabla), pero el diagnóstico no deja arrancar.
    directos: reglas.directos === undefined ? [] : listaDe(reglas.directos, "data/contratos/reglas.json, directos"),
    tarea,
    tareaReasignacion,
  };
}

/** Las reglas de un flujo. Se validan contra la nómina completa (activos e inactivos). */
export function cargarReglas(flujo: Flujo, todos: Persona[]): Reglas {
  const origen = `data/${flujo.clave}/reglas.json`;
  const reglas = leerJSON<ReglasAnalisisJSON & ReglasContratosJSON>(rutaFlujo(flujo, "reglas.json"), `las reglas de ${flujo.nombre} (${origen})`);
  if (flujo.clave !== "contratos") return validarReglasAnalisis(reglas, todos, origen);
  const opcional = <T>(archivo: string): T | null =>
    existsSync(rutaFlujo(flujo, archivo)) ? leerJSON<T>(rutaFlujo(flujo, archivo), `data/contratos/${archivo}`) : null;
  return validarReglasContratos(reglas, opcional<AsesoresJSON>("asesores.json"), opcional<PropietariosJSON>("propietarios.json"), todos);
}

// ── Tabla de asesores (el Excel de Ana) ───────────────────────────────────────

/** Los archivos de un zip (un .xlsx es un zip de XML). Sin dependencias: solo lo necesario para leer un .xlsx. */
export function leerZip(buf: Buffer): Map<string, Buffer> {
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new ErrorUso("El archivo no es un .xlsx válido (no se encontró el índice del zip).");
  const total = buf.readUInt16LE(fin + 10);
  const salida = new Map<string, Buffer>();
  for (let n = 0, p = buf.readUInt32LE(fin + 16); n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ErrorUso("El archivo no es un .xlsx válido (índice del zip dañado).");
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString("utf8", p + 46, p + 46 + largoNombre);
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(inicio, inicio + comprimido);
    if (metodo === 0) salida.set(nombre, datos);
    else if (metodo === 8) salida.set(nombre, inflateRawSync(datos));
    p += 46 + largoNombre + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return salida;
}

const textoXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const t = e.toLowerCase();
    if (t.startsWith("#x")) return String.fromCodePoint(parseInt(t.slice(2), 16));
    if (t.startsWith("#")) return String.fromCodePoint(parseInt(t.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[t];
  });

const textosDe = (xml: string): string => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => textoXml(t[1])).join("");

/** Las hojas de un .xlsx, cada una como filas de celdas de texto (en su columna; las vacías quedan como ""). */
export function hojasDeXlsx(buf: Buffer): string[][][] {
  const zip = leerZip(buf);
  const comunes: string[] = [];
  const compartidos = zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  for (const si of compartidos.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) comunes.push(textosDe(si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  const numero = (nombre: string) => Number(/(\d+)\.xml$/.exec(nombre)?.[1] ?? 0);
  const hojas = [...zip.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => numero(a) - numero(b));
  return hojas.map((nombre) => {
    const xml = zip.get(nombre)!.toString("utf8");
    const filas: string[][] = [];
    for (const fila of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const celdas: string[] = [];
      let siguiente = 0;
      for (const c of (fila[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+)\d+"/.exec(c[1])?.[1];
        const col = ref ? [...ref].reduce((n, letra) => n * 26 + letra.charCodeAt(0) - 64, 0) - 1 : siguiente;
        siguiente = col + 1;
        const tipo = /\bt="([^"]+)"/.exec(c[1])?.[1];
        const cuerpo = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1];
        celdas[col] = tipo === "s" ? (comunes[Number(v)] ?? "") : tipo === "inlineStr" ? textosDe(cuerpo) : v === undefined ? "" : textoXml(v);
      }
      filas.push(Array.from(celdas, (x) => x ?? ""));
    }
    return filas;
  });
}

/** Filas de un CSV (separado por ; , o tabulador, el que más aparezca en la primera línea), con comillas. */
export function filasDeCsv(texto: string): string[][] {
  const limpio = texto.replace(/^\uFEFF/, "");
  const primera = limpio.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t"].reduce((mejor, s) => (primera.split(s).length > primera.split(mejor).length ? s : mejor), ",");
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let comillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const ch = limpio[i];
    if (comillas) {
      if (ch !== '"') celda += ch;
      else if (limpio[i + 1] === '"') {
        celda += '"';
        i++;
      } else comillas = false;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) {
      fila.push(celda);
      celda = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && limpio[i + 1] === "\n") i++;
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = "";
    } else celda += ch;
  }
  if (celda || fila.length) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}

/** Un .xlsx o un .csv (UTF-8 o el ANSI de Excel en Windows) como hojas de filas de celdas. */
export function leerTabla(ruta: string): string[][][] {
  let buf: Buffer;
  try {
    buf = readFileSync(ruta);
  } catch {
    throw new ErrorUso(`No se encontró el archivo ${ruta}`);
  }
  const ext = extname(ruta).toLowerCase();
  if (ext === ".xlsx") return hojasDeXlsx(buf);
  if (ext !== ".csv" && ext !== ".txt") throw new ErrorUso(`Solo se leen archivos .xlsx o .csv (este es ${ext || "sin extensión"}). Un .xls viejo se guarda primero como .xlsx.`);
  let texto: string;
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    texto = new TextDecoder("windows-1252").decode(buf);
  }
  return [filasDeCsv(texto)];
}

export interface TablaAsesores {
  claves: Record<string, string[]>;
  filas: number;
  noReconocidos: string[];
  columnas: { hoja: number; clave: string; ejecutivo: string };
}

/** La persona de la nómina que corresponde a un nombre del Excel (nombre y apellido, sin tildes ni mayúsculas), o null. */
function personaPorNombre(todos: Persona[], nombre: string): string | null {
  const n = normalizar(nombre);
  const hallados = todos.filter((a) => normalizar(a.nombre) === n || normalizar(a.etiqueta) === n || coincideNombre(a.nombre, nombre));
  return hallados.length === 1 ? hallados[0].clave : null;
}

/**
 * Clave del asesor → ejecutivos, a partir del Excel de Ana: busca (en las primeras 30 filas de cada hoja) un encabezado
 * con una columna de clave o código del asesor y otra de ejecutivo. Una celda puede traer varios ejecutivos ("A / B",
 * "A y B"); una clave repetida en varias filas suma ejecutivos.
 */
export function tablaDeAsesores(hojas: string[][][], todos: Persona[]): TablaAsesores {
  const vistos: string[] = [];
  for (const [h, filas] of hojas.entries()) {
    for (let i = 0; i < Math.min(filas.length, 30); i++) {
      const enc = filas[i].map((c) => normalizar(c ?? ""));
      const colEj = enc.findIndex((t) => t.includes("ejecutivo") && !/\b(clave|codigo|cod|cedula|documento|correo)\b/.test(t));
      const claves = enc.flatMap((t, j) => (/\b(clave|codigo|cod)\b/.test(t) && !t.includes("ejecutivo") ? [j] : []));
      const colClave = claves.find((j) => enc[j].includes("asesor")) ?? claves[0];
      if (filas[i].some(Boolean) && vistos.length < 6) vistos.push(filas[i].filter(Boolean).join(" | "));
      if (colEj < 0 || colClave === undefined) continue;

      const mapa = new Map<string, Set<string>>();
      const noReconocidos = new Set<string>();
      let leidas = 0;
      for (const fila of filas.slice(i + 1)) {
        const clave = normalizarCodigo(fila[colClave]);
        const texto = (fila[colEj] ?? "").trim();
        if (!clave || !texto) continue;
        leidas++;
        for (const nombre of texto.split(/\s*(?:\/|,|;|\n|\s-\s|\by\b)\s*/i).filter(Boolean)) {
          const k = personaPorNombre(todos, nombre);
          if (!k) noReconocidos.add(nombre);
          else if (mapa.has(clave)) mapa.get(clave)!.add(k);
          else mapa.set(clave, new Set([k]));
        }
      }
      const ordenadas = [...mapa.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      return {
        claves: Object.fromEntries(ordenadas.map((k) => [k, [...mapa.get(k)!].sort()])),
        filas: leidas,
        noReconocidos: [...noReconocidos].sort(),
        columnas: { hoja: h + 1, clave: filas[i][colClave], ejecutivo: filas[i][colEj] },
      };
    }
  }
  throw new ErrorUso(
    `No se encontró una hoja con una columna de clave (o código) del asesor y otra de ejecutivo en las primeras 30 filas. Primeras filas: ${vistos.join(" / ") || "(vacío)"}.`,
  );
}

function importarAsesores(ruta: string): number {
  const flujo = FLUJOS.find((f) => f.clave === "contratos")!;
  const { todos } = cargarNomina(flujo);
  const t = tablaDeAsesores(leerTabla(ruta), todos);
  console.log(`Hoja ${t.columnas.hoja}: columna de clave "${t.columnas.clave}" y de ejecutivo "${t.columnas.ejecutivo}"; ${t.filas} filas con datos.`);
  if (t.noReconocidos.length) {
    throw new ErrorUso(
      `Hay ${t.noReconocidos.length} nombre(s) de ejecutivo que no se reconocen en data/contratos/nomina.json: ${t.noReconocidos.join(", ")}. ` +
        "Hay que agregarlos a la nómina (o corregir el nombre) y volver a importar. No se guardó nada.",
    );
  }
  const salida = {
    _ayuda: "Clave del asesor → ejecutivo(s), generado con: node asignacion_equilibrada.ts --importar-asesores <archivo>. No se edita a mano: se vuelve a importar el Excel de Ana. Las claves compartidas de reglas.json mandan sobre esta tabla.",
    fuente: basename(ruta),
    importado: new Date().toISOString(),
    claves: t.claves,
  };
  // Antes de guardar: que la tabla pase la misma validación que usa cada ciclo.
  validarReglasContratos({}, salida, null, todos);
  writeFileSync(rutaFlujo(flujo, "asesores.json"), JSON.stringify(salida, null, 2) + "\n");

  const etiqueta = (k: string) => todos.find((a) => a.clave === k)?.etiqueta ?? k;
  const porEjecutivo = new Map<string, number>();
  const varias: string[] = [];
  for (const [clave, lista] of Object.entries(t.claves)) {
    if (lista.length > 1) varias.push(`${clave} (${lista.map(etiqueta).join(", ")})`);
    else porEjecutivo.set(lista[0], (porEjecutivo.get(lista[0]) ?? 0) + 1);
  }
  console.table(Object.fromEntries([...porEjecutivo].sort((a, b) => b[1] - a[1]).map(([k, n]) => [etiqueta(k), { "claves fijas": n }])));
  console.log(`Claves con varios ejecutivos: ${varias.join("; ") || "ninguna"}`);
  console.log(`${Object.keys(t.claves).length} claves guardadas en data/contratos/asesores.json.`);
  return 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. CLIENTE DE HUBSPOT
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

/** El cursor de paginación, codificado una sola vez (HubSpot a veces ya lo entrega codificado). */
const cursor = (after: string) => encodeURIComponent(decodeURIComponent(after));

/** Todas las páginas de una búsqueda. La API corta en 10.000 resultados; antes de eso se avisa. */
async function buscarTodo(hs: ClienteHS, objeto: string, cuerpo: Record<string, unknown>): Promise<RegistroHS[]> {
  const todos: RegistroHS[] = [];
  let after: string | undefined;
  do {
    const pagina = await hs.solicitar<PaginaHS>("POST", `/crm/objects/${API}/${objeto}/search`, {
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
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

/** Filtros de la cola: un grupo por etapa de origen (con sus filtros) y, si el flujo lo pide, sin propietario. */
export function filtrosCola(flujo: Flujo): { filters: Record<string, string>[] }[] {
  return flujo.colas.map((c) => {
    const filters: Record<string, string>[] = [
      { propertyName: "hs_pipeline", operator: "EQ", value: flujo.pipeline },
      { propertyName: "hs_pipeline_stage", operator: "EQ", value: c.etapa },
      ...(c.filtros ?? []).map((f) => ({ propertyName: f.propiedad, operator: "EQ", value: f.valor })),
    ];
    if (flujo.colaSinPropietario) filters.push({ propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" });
    return { filters };
  });
}

/** Si un registro (releído) sigue en la cola del flujo. */
export function cumpleCola(flujo: Flujo, props: Propiedades): boolean {
  if (flujo.colaSinPropietario && props.hubspot_owner_id) return false;
  return flujo.colas.some((c) => props.hs_pipeline_stage === c.etapa && (c.filtros ?? []).every((f) => props[f.propiedad] === f.valor));
}

/** Lo que se lee de cada registro de la cola. */
export function propiedadesCola(flujo: Flujo, reglas: Reglas): string[] {
  return unicos([
    "hs_pipeline_stage",
    "hubspot_owner_id",
    "hs_v2_date_entered_current_stage",
    ...flujo.colas.flatMap((c) => (c.filtros ?? []).map((f) => f.propiedad)),
    ...flujo.leer,
    ...(flujo.monto.asociado ? [] : flujo.monto.propiedades),
    ...(reglas.tipo === "analisis_riesgo" ? (reglas.directo?.condiciones ?? []).map((c) => c.propiedad) : []),
  ]);
}

/** Lo que el modo activo escribe en cada registro del flujo. Lo que tenía antes queda en el log, para revertir_asignacion.ts. */
export function propiedadesEscritas(flujo: Flujo): string[] {
  const r = flujo.reasignacion;
  return ["hubspot_owner_id", "hs_pipeline_stage", flujo.propFecha, "asignacion_detalle", ...(r ? [r.anterior, r.contador, r.fecha] : [])];
}

/** Todo lo que el script ha escrito alguna vez, en cualquier flujo (incluida la fecha que usaba Contratos antes del motor v2). */
export const TODAS_LAS_ESCRITAS: readonly string[] = unicos([...FLUJOS.flatMap(propiedadesEscritas), "fecha_asignacion_analista"]);

/** La cola: registros en las etapas de origen del flujo que cumplen sus filtros. */
function leerCola(ctx: Contexto): Promise<RegistroHS[]> {
  return buscarTodo(ctx.hs, ctx.cfg.objeto, { filterGroups: filtrosCola(ctx.flujo), properties: propiedadesCola(ctx.flujo, ctx.reglas) });
}

/** Un objeto asociado y los tipos de asociación con que lo está. */
interface Asociado {
  id: string;
  tipos: number[];
}

/** Los asociados de tipo `a` de cada registro de tipo `de` (lecturas por lotes). */
async function asociadosPorLotes(hs: ClienteHS, de: string, a: string, ids: string[]): Promise<Map<string, Asociado[]>> {
  const salida = new Map<string, Asociado[]>();
  for (const lote of enLotes(unicos(ids), 100)) {
    const res = await hs.solicitar<{ results?: { from: { id: string | number }; to?: { toObjectId: string | number; associationTypes?: { typeId: number }[] }[] }[] }>(
      "POST",
      `/crm/associations/${API}/${de}/${a}/batch/read`,
      { inputs: lote.map((id) => ({ id })) },
    );
    for (const x of res.results ?? []) {
      salida.set(String(x.from.id), (x.to ?? []).map((t) => ({ id: String(t.toObjectId), tipos: (t.associationTypes ?? []).map((y) => y.typeId) })));
    }
  }
  return salida;
}

/** Propiedades de varios objetos de un tipo (lecturas por lotes). */
async function leerPorLotes(hs: ClienteHS, tipo: string, ids: string[], propiedades: string[]): Promise<Map<string, Propiedades>> {
  const salida = new Map<string, Propiedades>();
  for (const lote of enLotes(unicos(ids), 100)) {
    const res = await hs.solicitar<{ results?: RegistroHS[] }>("POST", `/crm/objects/${API}/${tipo}/batch/read`, { properties: propiedades, inputs: lote.map((id) => ({ id })) });
    for (const x of res.results ?? []) salida.set(String(x.id), x.properties);
  }
  return salida;
}

/**
 * El monto entre los objetos asociados a un registro: el del más reciente de la pipeline del flujo que tenga dato (la
 * Radicación); si ninguno de esa pipeline lo tiene, el del más reciente de cualquiera. null si nadie tiene dato.
 */
export function elegirMonto(objetos: { id: string; props: Propiedades }[], monto: Monto): number | null {
  const recientes = [...objetos].sort((x, y) => Number(y.id) - Number(x.id)); // en HubSpot, un id mayor es un objeto más nuevo
  const preferidos = monto.pipeline ? recientes.filter((o) => o.props.pipeline === monto.pipeline!.id) : [];
  for (const o of [...preferidos, ...recientes]) {
    const m = monto.calcular(o.props);
    if (m !== null) return m;
  }
  return null;
}

/**
 * El monto de cada registro: de sus propiedades o, si el flujo lo dice, de sus objetos asociados. Con `pipeline`, si el
 * registro no tiene asociado un objeto de esa pipeline, se busca un nivel más: el Análisis está asociado a la Solicitud
 * y el canon está en la Radicación asociada a esa Solicitud.
 */
async function montosDe(ctx: Pick<Contexto, "hs" | "cfg" | "flujo">, registros: RegistroHS[]): Promise<Map<string, number | null>> {
  const { monto } = ctx.flujo;
  const salida = new Map<string, number | null>();
  if (!monto.asociado) {
    for (const r of registros) salida.set(r.id, monto.calcular(r.properties));
    return salida;
  }
  const tipo = monto.asociado;
  const propiedades = unicos([...monto.propiedades, ...(monto.pipeline ? ["pipeline"] : [])]);
  const directos = await asociadosPorLotes(ctx.hs, ctx.cfg.objeto, tipo, registros.map((r) => r.id));
  const datos = await leerPorLotes(ctx.hs, tipo, [...directos.values()].flat().map((a) => a.id), propiedades);

  let segundo = new Map<string, Asociado[]>();
  if (monto.pipeline) {
    const pipeline = monto.pipeline.id;
    const intermedios = registros.flatMap((r) => {
      const suyos = directos.get(r.id) ?? [];
      return suyos.some((a) => datos.get(a.id)?.pipeline === pipeline) ? [] : suyos.map((a) => a.id);
    });
    if (intermedios.length) {
      segundo = await asociadosPorLotes(ctx.hs, tipo, tipo, intermedios);
      const nuevos = [...segundo.values()].flat().map((a) => a.id).filter((id) => !datos.has(id));
      for (const [id, p] of await leerPorLotes(ctx.hs, tipo, nuevos, propiedades)) datos.set(id, p);
    }
  }
  for (const r of registros) {
    const primeros = (directos.get(r.id) ?? []).map((a) => a.id);
    const ids = unicos([...primeros, ...primeros.flatMap((id) => (segundo.get(id) ?? []).map((a) => a.id))]);
    salida.set(r.id, elegirMonto(ids.flatMap((id) => (datos.has(id) ? [{ id, props: datos.get(id)! }] : [])), monto));
  }
  return salida;
}

/** El primer documento con dato de un contacto (en el orden de PROPS_DOCUMENTO_CONTACTO). */
const documentoDe = (p: Propiedades | undefined): string => PROPS_DOCUMENTO_CONTACTO.map((n) => String(p?.[n] ?? "").trim()).find(Boolean) ?? "";

/**
 * Contratos: de cada contrato, las claves de sus Asesores asociados (solo de los que no traen la clave en la propiedad)
 * y los documentos de sus contactos "Arrendador Cto" (lecturas por lotes).
 */
async function asociadosDeContratos(ctx: Pick<Contexto, "hs" | "cfg">, registros: RegistroHS[]): Promise<Map<string, { claves: string[]; documentos: string[] }>> {
  const salida = new Map(registros.map((r) => [r.id, { claves: [] as string[], documentos: [] as string[] }]));
  const { asesor, arrendador, objeto } = ctx.cfg;
  if (asesor) {
    const sinClave = registros.filter((r) => !normalizarCodigo(r.properties[PROP_CLAVE_ASESOR])).map((r) => r.id);
    const asoc = await asociadosPorLotes(ctx.hs, objeto, asesor.objeto, sinClave);
    const datos = await leerPorLotes(ctx.hs, asesor.objeto, [...asoc.values()].flat().map((a) => a.id), [asesor.propiedad]);
    for (const [id, lista] of asoc) {
      const s = salida.get(id);
      if (s) s.claves = lista.map((a) => String(datos.get(a.id)?.[asesor.propiedad] ?? "")).filter(Boolean);
    }
  }
  if (arrendador) {
    const asoc = await asociadosPorLotes(ctx.hs, objeto, "0-1", registros.map((r) => r.id));
    const contactos = new Map([...asoc].map(([id, lista]) => [id, lista.filter((a) => a.tipos.includes(arrendador.typeId)).map((a) => a.id)]));
    const datos = await leerPorLotes(ctx.hs, "0-1", [...contactos.values()].flat(), PROPS_DOCUMENTO_CONTACTO);
    for (const [id, lista] of contactos) {
      const s = salida.get(id);
      if (s) s.documentos = lista.map((c) => documentoDe(datos.get(c))).filter(Boolean);
    }
  }
  return salida;
}

/** Consulta del historial: registros con la fecha de asignación desde `desdeMs`. */
function cuerpoHistorial(flujo: Flujo, desdeMs: number): Record<string, unknown> {
  return {
    filterGroups: [{ filters: [{ propertyName: flujo.propFecha, operator: "GTE", value: String(desdeMs) }] }],
    properties: unicos(["hubspot_owner_id", flujo.propFecha, ...(flujo.monto.asociado ? [] : flujo.monto.propiedades)]),
  };
}

/**
 * Carga por historial: asignaciones de los últimos ~30 días hábiles a los del reparto. Salen de HubSpot (propietario
 * actual y fecha de asignación), así que una reasignación manual se ve en el siguiente ciclo. Del log se agregan: en
 * modo sombra, sus decisiones anteriores; en modo activo, solo las escrituras de los últimos minutos que la búsqueda de
 * HubSpot todavía no devuelve.
 */
async function leerHistorial(ctx: Contexto, ahora: number, desdeMs: number): Promise<Evento[]> {
  const { cfg, flujo } = ctx;
  const competidores = new Set(competidoresDe(ctx.pool).map((a) => a.clave));
  const claveDe = (r: RegistroHS) => cfg.claveDeOwner.get(r.properties.hubspot_owner_id ?? "");
  const registros = (await buscarTodo(ctx.hs, cfg.objeto, cuerpoHistorial(flujo, desdeMs))).filter(
    (r) => competidores.has(claveDe(r) ?? "") && parsearInstante(r.properties[flujo.propFecha]) !== null,
  );
  const montos = await montosDe(ctx, registros);
  const eventos: Evento[] = registros.map((r) => ({
    id: r.id,
    instante: parsearInstante(r.properties[flujo.propFecha])!,
    clave: claveDe(r)!,
    monto: montos.get(r.id) ?? null,
  }));

  const vistos = new Set(eventos.map((ev) => ev.id));
  for (const d of decisionesDelFlujo(ctx, desdeMs)) {
    if (vistos.has(d.id)) continue;
    const instante = Date.parse(d.fecha);
    const valida =
      ctx.modo === "sombra" ? d.escritura === ESCRITURA_SOMBRA : d.escritura === "ok" && ahora - instante <= GRACIA_INDICE_MS;
    if (!valida) continue;
    vistos.add(d.id);
    eventos.push({ id: d.id, instante, clave: d.elegido, monto: d.monto ?? d.canon ?? null });
  }
  return eventos;
}

/** Consulta de la carga en tiempo real: registros con propietario en las etapas abiertas después de la cola. */
function cuerpoCarga(flujo: Flujo, cfg: ConfigHS): Record<string, unknown> {
  return {
    filterGroups: [
      {
        filters: [
          { propertyName: "hs_pipeline", operator: "EQ", value: flujo.pipeline },
          { propertyName: "hs_pipeline_stage", operator: "IN", values: cfg.etapasAbiertas },
          { propertyName: "hubspot_owner_id", operator: "HAS_PROPERTY" },
        ],
      },
    ],
    properties: unicos(["hubspot_owner_id", flujo.propFecha, ...(flujo.monto.asociado ? [] : flujo.monto.propiedades)]),
  };
}

/**
 * Carga en tiempo real (R-06): lo que cada uno tiene abierto en HubSpot. En modo sombra se suman sus decisiones de los
 * registros que siguen en la cola (en HubSpot no se movieron); en modo activo, las escrituras de los últimos minutos
 * que la búsqueda todavía no devuelve.
 */
async function leerCarga(ctx: Contexto, ahora: number, desdeMs: number, enCola: Set<string>) {
  const { cfg, flujo } = ctx;
  const claveDe = (r: RegistroHS) => cfg.claveDeOwner.get(r.properties.hubspot_owner_id ?? "");
  const registros = cfg.etapasAbiertas.length ? (await buscarTodo(ctx.hs, cfg.objeto, cuerpoCarga(flujo, cfg))).filter((r) => claveDe(r)) : [];
  const montos = await montosDe(ctx, registros);
  const eventos: Evento[] = registros.map((r) => ({
    id: r.id,
    instante: parsearInstante(r.properties[flujo.propFecha]) ?? -Infinity,
    clave: claveDe(r)!,
    monto: montos.get(r.id) ?? null,
  }));
  const vistos = new Set(eventos.map((ev) => ev.id));
  for (const d of decisionesDelFlujo(ctx, desdeMs)) {
    if (vistos.has(d.id)) continue;
    const instante = Date.parse(d.fecha);
    const cuenta =
      ctx.modo === "sombra" ? d.escritura === ESCRITURA_SOMBRA && enCola.has(d.id) : d.escritura === "ok" && ahora - instante <= GRACIA_INDICE_MS;
    if (!cuenta) continue;
    vistos.add(d.id);
    eventos.push({ id: d.id, instante, clave: d.elegido, monto: d.monto ?? d.canon ?? null });
  }
  return estadoDeCarga(eventos, ctx.pool.map((a) => a.clave), ctx.params);
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. DIAGNÓSTICO (token, scopes, objeto, etapas, propiedades, reglas y propietarios)
// ═════════════════════════════════════════════════════════════════════════════

interface SchemaHS {
  objectTypeId: string;
  name?: string;
  labels?: { singular?: string; plural?: string };
}
interface PipelineHS {
  id: string;
  label: string;
  stages: { id: string; label: string; displayOrder: number; metadata?: { isClosed?: string; state?: string } }[];
}
interface PropiedadHS {
  name: string;
  label: string;
  type: string;
  options?: { value: string; label: string }[];
  /** "OWNER": la propiedad es de tipo propietario; acepta cualquier ownerId y la API no lista opciones. */
  referencedObjectType?: string;
}
interface PropietarioHS {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  /** null en los propietarios de usuarios desactivados (HubSpot los sigue listando). */
  userId?: number | null;
}

/**
 * De los propietarios que coinciden con un nombre, si son varios: los activos (con usuario) y, si siguen siendo varios,
 * los de nombre idéntico. En producción hay usuarios desactivados con nombres cortos ("Laura Calceto", "Andrea Torres",
 * "Andrea Castellanos") que coinciden con el de la persona activa.
 */
export function desempatarPropietarios<T extends { firstName?: string; lastName?: string; userId?: number | null }>(hallados: T[], nombre: string): T[] {
  if (hallados.length <= 1) return hallados;
  const activos = hallados.filter((o) => o.userId);
  const lista = activos.length ? activos : hallados;
  if (lista.length <= 1) return lista;
  const exactos = lista.filter((o) => normalizar(`${o.firstName ?? ""} ${o.lastName ?? ""}`) === normalizar(nombre));
  return exactos.length ? exactos : lista;
}
interface Paso {
  estado: "ok" | "aviso" | "error";
  texto: string;
}

const MARCA = { ok: "[OK]    ", aviso: "[AVISO] ", error: "[ERROR] " } as const;

/** Variable de entorno de un flujo, p. ej. HUBSPOT_CONTRATOS_OBJETO. */
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

async function listarPropietarios(hs: ClienteHS): Promise<PropietarioHS[]> {
  const todos: PropietarioHS[] = [];
  let after: string | undefined;
  do {
    const pagina = await hs.solicitar<{ results: PropietarioHS[]; paging?: { next?: { after: string } } }>(
      "GET",
      `/crm/owners/${API}?limit=500&archived=false${after ? `&after=${cursor(after)}` : ""}`,
    );
    todos.push(...pagina.results);
    after = pagina.paging?.next?.after;
  } while (after);
  return todos;
}

/**
 * Revisa todo lo que un flujo necesita de HubSpot y devuelve la configuración resuelta
 * (objeto, etapas, propiedades, propietarios y tareas), o null si algo falla.
 */
export async function diagnosticar(
  hs: ClienteHS,
  flujo: Flujo,
  pool: Persona[],
  params: Parametros,
  reglas: Reglas,
  imprimir = true,
): Promise<{ cfg: ConfigHS | null; pasos: Paso[] }> {
  const pasos: Paso[] = [];
  const nota = (estado: Paso["estado"], texto: string) => {
    pasos.push({ estado, texto });
    // Sin el encabezado del diagnóstico completo, cada aviso dice de qué flujo es.
    if (imprimir || estado !== "ok") console.log(`${MARCA[estado]}${imprimir ? "" : `${flujo.nombre} · `}${texto}`);
  };
  const origenNomina = `data/${flujo.clave}/nomina.json`;
  const etiqueta = (clave: string) => pool.find((a) => a.clave === clave)?.etiqueta ?? clave;

  // Datos locales
  nota("ok", `Nómina: ${resumenEquipo(pool, reglas, flujo.personas)}`);
  const edad = Math.floor((Date.now() - Date.parse(`${params.calibradoCon.hasta}T00:00:00-05:00`)) / 86_400_000);
  if (edad > EDAD_MAX_PARAMETROS_DIAS) {
    nota(
      "aviso",
      `Los parámetros se calibraron con datos hasta el ${params.calibradoCon.hasta} (hace ${edad} días). ` +
        (flujo.conTecho
          ? "Hay que recalcularlos con --parametros antes de activar."
          : `Sin techo solo se usa el monto típico (${cop(params.canonTipico)}): conviene recalcularlo con --parametros cuando AGSSA tenga datos recientes.`),
    );
  } else {
    nota("ok", `Parámetros calibrados con ${params.calibradoCon.desde} → ${params.calibradoCon.hasta} (${params.calibradoCon.casos} casos)`);
  }

  // Reglas
  if (reglas.tipo === "analisis_riesgo") {
    const d = reglas.directo;
    if (!d) nota("aviso", `Sin reglas de asignación directa en data/${flujo.clave}/reglas.json: todo entra al reparto.`);
    else {
      const activa = pool.some((a) => a.clave === d.persona);
      nota(
        activa ? "ok" : "error",
        `Directo a ${etiqueta(d.persona)}, aunque esté ausente: monto mayor que ${cop(d.montoMayorA)}${d.condiciones.map((c) => ` o ${c.motivo} (${c.propiedad} = ${c.valor})`).join("")}` +
          (activa ? "" : `. ${d.persona} no está activa en ${origenNomina}: esos registros esperarían siempre.`),
      );
    }
  } else {
    if (reglas.tabla.claves) nota("ok", `Tabla de asesores: ${reglas.tabla.claves} claves (${reglas.tabla.fuente ?? "sin fuente"}, importada el ${reglas.tabla.importado?.slice(0, 10) ?? "?"})`);
    else {
      nota(
        "aviso",
        "No hay tabla de asesores (data/contratos/asesores.json): solo deciden las claves compartidas y lo demás va a los ejecutivos de directos. " +
          "Se importa el Excel de Ana con: node asignacion_equilibrada.ts --importar-asesores <archivo.xlsx>",
      );
    }
    nota("ok", `Claves compartidas: ${[...reglas.compartidas].map(([k, v]) => `${k} (${v.map(etiqueta).join(", ")})`).join("; ") || "ninguna"}`);
    const inactivos = reglas.directos.filter((k) => !pool.some((a) => a.clave === k));
    if (!reglas.directos.length) nota("error", "Falta 'directos' en data/contratos/reglas.json: los ejecutivos que reciben lo que no tiene ejecutivo por regla.");
    else {
      nota(
        inactivos.length === reglas.directos.length ? "error" : inactivos.length ? "aviso" : "ok",
        `Ejecutivos de directos (sin asesor, clave fuera de la tabla o ejecutivo ausente): ${reglas.directos.map(etiqueta).join(", ")}` +
          (inactivos.length ? `. No están activos en ${origenNomina}: ${inactivos.join(", ")}` : ""),
      );
    }
    if (reglas.totalPropietarios) nota("ok", `Propietarios con ejecutivo fijo: ${reglas.totalPropietarios}`);
    else nota("aviso", "No hay propietarios con ejecutivo fijo (data/contratos/propietarios.json): falta copiar la lista del correo de Ana.");
  }

  // Objeto
  let objeto = valorDe(flujo, "OBJETO");
  if (objeto) {
    nota("ok", `Objeto: ${objeto} (fijado en ${variableDe(flujo, "OBJETO")})`);
  } else {
    try {
      const { results } = await hs.solicitar<{ results: SchemaHS[] }>("GET", `/crm-object-schemas/${API}/schemas`);
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

  // Pipeline y etapas (los IDs están en FLUJOS: son los mismos en el sandbox y en producción)
  let etapasAbiertas: string[] = [];
  let pipelineOk = false;
  if (objeto) {
    try {
      const { results } = await hs.solicitar<{ results: PipelineHS[] }>("GET", `/crm/pipelines/${API}/${objeto}`);
      const p = results.find((x) => x.id === flujo.pipeline);
      if (!p) {
        nota("error", `El objeto no tiene la pipeline ${flujo.pipeline} (FLUJOS en el código). Pipelines: ${results.map((x) => `${x.label} (${x.id})`).join(", ") || "ninguna"}.`);
      } else {
        const etapa = (id: string) => p.stages.find((s) => s.id === id);
        const faltan = [...flujo.colas.map((c) => c.etapa), flujo.destino.etapa].filter((id) => !etapa(id));
        if (faltan.length) {
          nota("error", `La pipeline "${p.label}" no tiene las etapas ${faltan.join(", ")} (FLUJOS en el código). Etapas: ${p.stages.map((s) => `${s.label} (${s.id})`).join(", ")}.`);
        } else {
          pipelineOk = true;
          const ultimaCola = Math.max(...flujo.colas.map((c) => etapa(c.etapa)!.displayOrder));
          etapasAbiertas = p.stages
            .filter((s) => s.displayOrder > ultimaCola && s.metadata?.isClosed !== "true" && s.metadata?.state !== "CLOSED" && !flujo.colas.some((c) => c.etapa === s.id))
            .map((s) => s.id);
          const origenes = flujo.colas.map((c) => `${etapa(c.etapa)!.label}${c.filtros?.length ? ` (${c.filtros.map((f) => `${f.propiedad} = ${f.valor}`).join(", ")})` : ""}`);
          nota("ok", `Pipeline "${p.label}" (${p.id}): ${origenes.join(" y ")} → ${etapa(flujo.destino.etapa)!.label}`);
          if (flujo.carga === "abiertos") {
            if (etapasAbiertas.length) nota("ok", `Carga en tiempo real: lo abierto en ${etapasAbiertas.map((id) => etapa(id)!.label).join(", ")}`);
            else nota("error", "No hay etapas abiertas después de la cola: no se puede medir la carga en tiempo real.");
          }
        }
      }
    } catch (error) {
      nota("error", `No se pudieron leer las pipelines del objeto: ${mensajeDe(error)}`);
    }
  }

  // Propiedades
  let opcionesAnterior: Set<string> | null = null;
  let anteriorEsPropietario = false;
  let fechaOk = false;
  if (objeto) {
    try {
      const { results } = await hs.solicitar<{ results: PropiedadHS[] }>("GET", `/crm/properties/${API}/${objeto}`);
      const porNombre = new Map(results.map((p) => [p.name, p]));
      for (const sistema of ["hubspot_owner_id", "hs_pipeline", "hs_pipeline_stage"]) {
        if (!porNombre.has(sistema)) nota("error", `El objeto no tiene la propiedad del sistema ${sistema} (¿el objeto tiene pipeline y propietario?).`);
      }
      const fecha = porNombre.get(flujo.propFecha);
      if (!fecha) nota("error", `Falta la propiedad ${flujo.propFecha}: hay que crearla en el objeto con tipo "Fecha y hora".`);
      else if (fecha.type !== "datetime") nota("error", `${flujo.propFecha} es de tipo "${fecha.type}" y debe ser "Fecha y hora" (datetime): sin la hora no se puede ordenar el reparto del día.`);
      else {
        fechaOk = true;
        nota("ok", `Propiedad de la fecha de asignación: ${flujo.propFecha}`);
      }
      if (!porNombre.has("asignacion_detalle")) nota("error", 'Falta la propiedad asignacion_detalle: hay que crearla en el objeto con tipo "Texto de varias líneas".');
      else nota("ok", "Propiedad asignacion_detalle");
      const leidas = unicos(propiedadesCola(flujo, reglas).filter((n) => !n.startsWith("hs_") && n !== "hubspot_owner_id"));
      const faltan = leidas.filter((n) => !porNombre.has(n));
      if (faltan.length) nota("error", `Faltan propiedades que leen la cola o las reglas: ${faltan.join(", ")}.`);
      else if (leidas.length) nota("ok", `Propiedades que leen la cola y las reglas: ${leidas.join(", ")}`);
      const r = flujo.reasignacion;
      if (r) {
        const faltanR = [r.anterior, r.contador, r.fecha].filter((n) => !porNombre.has(n));
        if (faltanR.length) nota("error", `Faltan las propiedades de reasignación: ${faltanR.join(", ")}.`);
        else {
          const def = porNombre.get(r.anterior)!;
          // De tipo propietario (así está en el sandbox y en producción): acepta cualquier propietario de la cuenta. Las
          // opciones se llenan abajo con la lista de propietarios.
          anteriorEsPropietario = def.referencedObjectType === "OWNER";
          if (!anteriorEsPropietario) opcionesAnterior = new Set((def.options ?? []).map((o) => o.value));
          nota(
            "ok",
            `Propiedades de reasignación: ${r.anterior} (${anteriorEsPropietario ? "de tipo propietario" : `${opcionesAnterior!.size} opciones`}), ${r.contador}, ${r.fecha}`,
          );
        }
      }
    } catch (error) {
      nota("error", `No se pudieron leer las propiedades del objeto: ${mensajeDe(error)}`);
    }
  }
  const m = flujo.monto;
  if (m.asociado) {
    try {
      const { results } = await hs.solicitar<{ results: PropiedadHS[] }>("GET", `/crm/properties/${API}/${m.asociado}`);
      const nombres = new Set(results.map((p) => p.name));
      const faltan = m.propiedades.filter((n) => !nombres.has(n));
      if (faltan.length) nota("error", `El objeto asociado ${m.asociado} no tiene ${faltan.join(", ")} (el ${m.descripcion}).`);
      else {
        let donde = `del objeto asociado ${m.asociado}`;
        if (m.pipeline) {
          const { results: pipelines } = await hs.solicitar<{ results: PipelineHS[] }>("GET", `/crm/pipelines/${API}/${m.asociado}`);
          const p = pipelines.find((x) => x.id === m.pipeline!.id);
          if (!p) nota("aviso", `Los objetos ${m.asociado} no tienen la pipeline ${m.pipeline.nombre} (${m.pipeline.id}): el monto saldrá del asociado que tenga dato.`);
          donde = `de la ${p?.label ?? m.pipeline.nombre} (${m.asociado}, pipeline ${m.pipeline.id}) asociada al registro o a su Solicitud`;
        }
        nota("ok", `Monto (${m.descripcion}): ${donde}, propiedades ${m.propiedades.join(", ")}`);
      }
    } catch (error) {
      nota("error", `No se pudieron leer las propiedades o pipelines del objeto asociado ${m.asociado} (scope crm.objects.deals.read): ${mensajeDe(error)}`);
    }
  } else {
    nota("ok", `Monto (${m.descripcion}): ${m.propiedades.join(", ")}`);
  }

  // Contratos: el Asesor asociado (clave) y los contactos "Arrendador Cto" (cédulas)
  let asesor: ConfigHS["asesor"] = null;
  let arrendador: ConfigHS["arrendador"] = null;
  if (reglas.tipo === "contratos" && objeto) {
    try {
      const { results } = await hs.solicitar<{ results: SchemaHS[] }>("GET", `/crm-object-schemas/${API}/schemas`);
      const s = results.find((x) => [x.labels?.singular, x.labels?.plural, x.name].some((t) => t && ASESOR.nombres.includes(normalizar(t))));
      if (!s) nota("aviso", `No hay un objeto "Asesores": la clave del asesor sale solo de ${PROP_CLAVE_ASESOR}.`);
      else {
        const { results: props } = await hs.solicitar<{ results: PropiedadHS[] }>("GET", `/crm/properties/${API}/${s.objectTypeId}`);
        if (!props.some((p) => p.name === ASESOR.propiedad)) nota("aviso", `El objeto Asesores (${s.objectTypeId}) no tiene ${ASESOR.propiedad}: la clave sale solo de ${PROP_CLAVE_ASESOR}.`);
        else {
          asesor = { objeto: s.objectTypeId, propiedad: ASESOR.propiedad };
          nota("ok", `Clave del asesor: ${PROP_CLAVE_ASESOR} o, si no la trae, ${ASESOR.propiedad} del Asesor asociado (${s.objectTypeId})`);
        }
      }
    } catch (error) {
      nota("error", `No se pudo leer el objeto Asesores (scope crm.schemas.custom.read): ${mensajeDe(error)}`);
    }
    try {
      const { results } = await hs.solicitar<{ results: { typeId: number; label: string | null }[] }>("GET", `/crm/associations/${API}/${objeto}/0-1/labels`);
      const tipo = results.find((x) => x.label && normalizar(x.label) === normalizar(ETIQUETA_ARRENDADOR));
      const { results: props } = await hs.solicitar<{ results: PropiedadHS[] }>("GET", `/crm/properties/${API}/0-1`);
      const conDocumento = PROPS_DOCUMENTO_CONTACTO.filter((n) => props.some((p) => p.name === n));
      if (!tipo) nota("aviso", `Los contratos no tienen la etiqueta de contacto "${ETIQUETA_ARRENDADOR}": la cédula del propietario sale solo de ${PROP_CEDULA_PROPIETARIO}.`);
      else if (!conDocumento.length) nota("aviso", `Los contactos no tienen ${PROPS_DOCUMENTO_CONTACTO.join(", ")}: la cédula del propietario sale solo de ${PROP_CEDULA_PROPIETARIO}.`);
      else {
        arrendador = { typeId: tipo.typeId };
        nota("ok", `Cédulas de los propietarios: contactos "${ETIQUETA_ARRENDADOR}" (tipo ${tipo.typeId}), ${conDocumento.join(" o ")}; y ${PROP_CEDULA_PROPIETARIO}`);
      }
    } catch (error) {
      nota("error", `No se pudieron leer los contactos asociados a los contratos (scopes crm.objects.contacts.read y crm.schemas.contacts.read): ${mensajeDe(error)}`);
    }
  }

  // Propietarios ↔ nómina
  const claveDeOwner = new Map<string, string>();
  const ownerDeClave = new Map<string, string>();
  const nombreDeOwner = new Map<string, string>();
  let propietarios: PropietarioHS[] = [];
  const nombreDe = (o: PropietarioHS) => `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email || o.id;
  try {
    propietarios = await listarPropietarios(hs);
    for (const o of propietarios) nombreDeOwner.set(o.id, nombreDe(o));
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
        hallados = desempatarPropietarios(propietarios.filter((o) => coincideNombre(a.nombre, `${o.firstName ?? ""} ${o.lastName ?? ""}`)), a.nombre);
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
  if (anteriorEsPropietario && propietarios.length) opcionesAnterior = new Set(propietarios.map((o) => o.id));
  if (opcionesAnterior && flujo.reasignacion) {
    const sinOpcion = pool.filter((a) => ownerDeClave.has(a.clave) && !opcionesAnterior!.has(ownerDeClave.get(a.clave)!));
    if (sinOpcion.length) {
      nota("aviso", `${flujo.reasignacion.anterior} no tiene como opción a ${sinOpcion.map((a) => a.etiqueta).join(", ")}: si se le reasigna un contrato a alguien que estaba con ellos, el ejecutivo anterior no se anota (el resto de la reasignación sí).`);
    }
  }

  // Tareas a coordinación: si un registro no se asigna a tiempo y si un contrato traía otro ejecutivo
  let tarea: ConfigHS["tarea"] = null;
  let tareaReasignacion: ConfigHS["tareaReasignacion"] = null;
  if (reglas.tipo === "contratos" && (reglas.tarea || reglas.tareaReasignacion) && objeto && propietarios.length) {
    const resolver = (responsables: string[], cual: string): TareaHS["owners"] | null => {
      const owners: TareaHS["owners"] = [];
      for (const r of responsables) {
        const hallados = /^\d+$/.test(r)
          ? propietarios.filter((o) => o.id === r)
          : desempatarPropietarios(propietarios.filter((o) => coincideNombre(r, `${o.firstName ?? ""} ${o.lastName ?? ""}`)), r);
        if (hallados.length === 1) owners.push({ nombre: nombreDe(hallados[0]), id: hallados[0].id });
        else nota("error", `Responsable de ${cual} "${r}" (data/${flujo.clave}/reglas.json): ${hallados.length ? "varios propietarios coinciden" : "no se encontró en HubSpot"}; hay que escribir su ownerId.`);
      }
      return owners.length === responsables.length ? owners : null;
    };
    try {
      const { results } = await hs.solicitar<{ results: { category: string; typeId: number; label: string | null }[] }>("GET", `/crm/associations/${API}/tasks/${objeto}/labels`);
      const tipo = results.find((x) => !x.label) ?? results[0];
      if (!tipo) nota("error", "Las tareas no se pueden asociar a este objeto (no hay un tipo de asociación tareas → objeto).");
      else {
        const asociacion = { associationCategory: tipo.category, associationTypeId: tipo.typeId };
        const sinAsignar = reglas.tarea ? resolver(reglas.tarea.responsables, "la tarea por no asignar a tiempo") : null;
        if (reglas.tarea && sinAsignar) {
          tarea = { owners: sinAsignar, asociacion };
          nota("ok", `Si un registro no se asigna en ${reglas.tarea.minutos} min, tarea para ${sinAsignar.map((o) => o.nombre).join(" y ")}`);
        }
        const porReasignacion = reglas.tareaReasignacion ? resolver(reglas.tareaReasignacion.responsables, "la tarea por reasignación") : null;
        if (porReasignacion) {
          tareaReasignacion = { owners: porReasignacion, asociacion };
          nota("ok", `Si un contrato traía otro ejecutivo, tarea para ${porReasignacion.map((o) => o.nombre).join(" y ")} con el anterior y el nuevo`);
        }
      }
    } catch (error) {
      nota("error", `No se pudo leer cómo se asocian las tareas al objeto: ${mensajeDe(error)}`);
    }
  }

  // Lectura de la cola y de la carga, con las mismas consultas que usa cada ciclo
  if (objeto && pipelineOk) {
    try {
      const prueba = await hs.solicitar<{ total?: number; results?: RegistroHS[] }>("POST", `/crm/objects/${API}/${objeto}/search`, {
        filterGroups: filtrosCola(flujo),
        properties: propiedadesCola(flujo, reglas),
        limit: 1,
      });
      nota("ok", `Lectura de la cola: ${prueba.total ?? "?"} registro(s) esperando ${flujo.persona}`);
      const primero = prueba.results?.[0];
      if (primero && flujo.monto.asociado) {
        const montos = await montosDe({ hs, flujo, cfg: { objeto } as ConfigHS }, [primero]);
        const valor = montos.get(primero.id) ?? null;
        nota(valor === null ? "aviso" : "ok", `Monto del primer registro de la cola (#${primero.id}): ${valor === null ? "sin dato (cuenta como un caso típico y no puede ir directo por monto)" : cop(valor)}`);
      }
      // Contratos: la misma lectura de asociados que hace cada ciclo, con el primero de la cola o, si está vacía, el más reciente.
      if (reglas.tipo === "contratos" && (asesor || arrendador)) {
        const muestra =
          primero ??
          (await hs.solicitar<{ results?: RegistroHS[] }>("POST", `/crm/objects/${API}/${objeto}/search`, {
            filterGroups: [{ filters: [{ propertyName: "hs_pipeline", operator: "EQ", value: flujo.pipeline }] }],
            properties: propiedadesCola(flujo, reglas),
            sorts: [{ propertyName: "hs_object_id", direction: "DESCENDING" }],
            limit: 1,
          })).results?.[0];
        if (muestra) {
          const a = (await asociadosDeContratos({ hs, cfg: { objeto, asesor, arrendador } as ConfigHS }, [muestra])).get(muestra.id)!;
          const datos = datosContrato(muestra.properties, a);
          nota("ok", `Lectura de asociados del contrato #${muestra.id}: clave del asesor ${datos.clave || "sin dato"}; ${a.documentos.length} arrendador(es) con documento`);
        }
      }
    } catch (error) {
      nota("error", `No se pudo leer la cola o sus asociados (scopes crm.objects.custom.read, crm.objects.deals.read y crm.objects.contacts.read): ${mensajeDe(error)}`);
    }
    if (fechaOk) {
      try {
        const cuerpo = flujo.carga === "abiertos" ? cuerpoCarga(flujo, { etapasAbiertas } as ConfigHS) : cuerpoHistorial(flujo, Date.now() - 30 * 86_400_000);
        const prueba = await hs.solicitar<{ total?: number }>("POST", `/crm/objects/${API}/${objeto}/search`, { ...cuerpo, limit: 1 });
        nota("ok", flujo.carga === "abiertos" ? `Lectura de la carga: ${prueba.total ?? "?"} registro(s) abiertos con propietario` : `Lectura del historial (${flujo.propFecha}, últimos 30 días): ${prueba.total ?? "?"} registro(s)`);
      } catch (error) {
        nota("error", `No se pudo leer ${flujo.carga === "abiertos" ? "la carga" : "el historial de asignaciones"}: ${mensajeDe(error)}`);
      }
    }
  }

  const hayErrores = pasos.some((p) => p.estado === "error");
  if (hayErrores || !objeto || !pipelineOk) return { cfg: null, pasos };
  return {
    cfg: {
      objeto,
      pipeline: flujo.pipeline,
      etapasCola: flujo.colas.map((c) => c.etapa),
      etapaDestino: flujo.destino.etapa,
      etapasAbiertas,
      claveDeOwner,
      ownerDeClave,
      nombreDeOwner,
      opcionesAnterior,
      tarea,
      tareaReasignacion,
      asesor,
      arrendador,
    },
    pasos,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. CICLO DE ASIGNACIÓN
// ═════════════════════════════════════════════════════════════════════════════

/** El texto que queda en asignacion_detalle: por qué se eligió a esa persona. */
function textoDetalle(flujo: Flujo, destino: Destino, monto: number | null, r: Reparto, instante: number, antes: string | null = null): string {
  const partes = [
    `Motor ${VERSION_MOTOR}`,
    `${horaLocal(instante)} hora Colombia`,
    monto === null ? `${flujo.monto.descripcion}: sin dato, se usó el típico` : `${flujo.monto.descripcion} ${cop(monto)}`,
    `regla: ${destino.regla}`,
    ...(antes ? [`reasignación: antes lo tenía ${antes}`] : []),
  ];
  const d = destino.decision;
  if (d) {
    partes.push(
      `w=${d.w.toFixed(2)}`,
      [...d.candidatos]
        .sort((x, y) => x.delta - y.delta)
        .map((c) => `${r.nombres(c.clave)} Δ=${c.delta.toFixed(3)}${c.clave === d.elegido ? " (elegido)" : ""}`)
        .join("; "),
    );
    if (d.respaldo) partes.push("monto sobre el techo de todos los presentes: se eligió al de mayor techo");
  }
  return partes.join(" | ");
}

/** El interruptor que frena este flujo (el general o el suyo), o null si no hay ninguno. */
function pausaActiva(flujo: Flujo): string | null {
  if (existsSync(RUTA.pausa)) return "data/PAUSA";
  return existsSync(rutaFlujo(flujo, "PAUSA")) ? `data/${flujo.clave}/PAUSA` : null;
}

/** Una asignación directa (sin el algoritmo) también cuenta en la carga de quien la recibe, si está en el reparto. */
function contarDirecto(estado: Estado, flujo: Flujo, competidores: Persona[], clave: string, w: number, p: Parametros): void {
  if (!(clave in estado.e)) return;
  if (flujo.carga === "historial" && competidores.length) subirMeta(estado, competidores, w, p);
  registrarAsignacion(estado, clave, w);
}

interface SinAsignar {
  registro: RegistroHS;
  motivo: string;
}

/** Crea una tarea en HubSpot para un propietario, asociada al registro. Devuelve "ok" o el error (y lo alerta). */
async function crearTarea(ctx: Contexto, tarea: TareaHS, owner: TareaHS["owners"][number], id: string, asunto: string, cuerpo: string, prioridad: "HIGH" | "MEDIUM"): Promise<string> {
  try {
    await ctx.hs.solicitar("POST", `/crm/objects/${API}/tasks`, {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_task_subject: asunto,
        hs_task_body: cuerpo,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: prioridad,
        hs_task_type: "TODO",
        hubspot_owner_id: owner.id,
      },
      associations: [{ to: { id }, types: [tarea.asociacion] }],
    });
    return "ok";
  } catch (error) {
    alerta(ctx.flujo, "tarea_fallida", `No se pudo crear la tarea de ${owner.nombre} para el registro ${id}: ${mensajeDe(error)}`, { id });
    return `error: ${mensajeDe(error)}`;
  }
}

/**
 * Lo que ninguna regla pudo asignar. Con tarea en las reglas (contratos): cuando lleva más de N minutos en la etapa, una
 * tarea para cada responsable, una sola vez por registro. Sin tarea: una línea "en_espera" por registro y por día
 * (n8n dispara cada 30 s; no hace falta repetirla).
 */
async function avisarSinAsignar(ctx: Contexto, lista: SinAsignar[], ahora: number, desdeMs: number): Promise<void> {
  if (!lista.length) return;
  const { flujo, cfg, reglas } = ctx;
  const comun = { flujo: flujo.clave, modo: ctx.modo, entorno: ctx.entorno };
  if (reglas.tipo !== "contratos" || !reglas.tarea || !cfg.tarea) {
    const ya = new Set(lineasDelFlujo(ctx, "en_espera", Date.parse(`${fechaBogota(ahora)}T00:00:00-05:00`)).map((l) => l.id));
    for (const { registro, motivo } of lista) {
      if (ya.has(registro.id)) continue;
      console.error(`[ESPERA] ${flujo.nombre} #${registro.id}: ${motivo}`);
      registrar({ tipo: "en_espera", ...comun, id: registro.id, motivo }, ahora);
    }
    return;
  }
  const { minutos } = reglas.tarea;
  const hechas = new Set(
    lineasDelFlujo(ctx, "tarea", desdeMs)
      .filter((l) => l.escritura === "ok" || l.escritura === ESCRITURA_SOMBRA)
      .map((l) => `${l.id}|${l.ownerId}`),
  );
  for (const { registro, motivo } of lista) {
    const entro = parsearInstante(registro.properties.hs_v2_date_entered_current_stage);
    if (entro === null || ahora - entro < minutos * 60_000) continue;
    for (const owner of cfg.tarea.owners) {
      if (hechas.has(`${registro.id}|${owner.id}`)) continue;
      const escritura =
        ctx.modo === "activo"
          ? await crearTarea(
              ctx,
              cfg.tarea,
              owner,
              registro.id,
              `${flujo.nombre}: registro ${registro.id} sin ${flujo.persona}`,
              `El algoritmo de asignación no pudo asignar este registro en ${minutos} minutos (${motivo}). Sigue en la etapa de asignación: hay que asignarlo a mano.`,
              "HIGH",
            )
          : ESCRITURA_SOMBRA;
      registrar({ tipo: "tarea", ...comun, id: registro.id, ownerId: owner.id, responsable: owner.nombre, motivo, escritura });
      console.log(`  ${flujo.nombre} #${registro.id} sin asignar hace ${minutos} min o más (${motivo}): tarea para ${owner.nombre} [${escritura}]`);
    }
  }
}

/**
 * Un ciclo de un flujo: lee la cola, mide la carga, decide por orden de monto (de mayor a menor) con las reglas del
 * flujo y, en modo activo, relee cada registro antes de escribirlo.
 */
export async function ejecutarCiclo(ctx: Contexto, ahora: number = Date.now()): Promise<ResumenCiclo> {
  const resumen: ResumenCiclo = { cola: 0, decididos: 0, escritos: 0, omitidos: 0, enEspera: 0 };
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

  const desdeMs = Date.parse(`${inicioVentana(hoy, cal)}T00:00:00-05:00`);

  // En modo sombra los registros no salen de la cola: lo que ya se decidió dentro de la ventana no se vuelve a decidir.
  let pendientes = cola;
  if (ctx.modo === "sombra") {
    const ya = new Set(decisionesDelFlujo(ctx, desdeMs).filter((d) => d.escritura === ESCRITURA_SOMBRA).map((d) => d.id));
    pendientes = cola.filter((r) => !ya.has(r.id));
    if (!pendientes.length) return resumen;
  }

  const presentes = presentesEn(hoy, ctx.pool, cal, ctx.ignorarHorario);
  // Sin nadie presente igual se revisa la cola: una regla puede mandarle a alguien aunque esté ausente (Mónica).
  if (!presentes.length) alerta(flujo, "nadie_presente", `Hay ${pendientes.length} registro(s) en la cola y nadie presente hoy; solo se asigna lo que va directo.`);
  if (ctx.modo === "activo" && cola.length > MAX_COLA_ACTIVA) {
    alerta(flujo, "cola_inusual", `La cola tiene ${cola.length} registros (más de ${MAX_COLA_ACTIVA}); no se escribe nada hasta que alguien la revise.`);
    await avisarSinAsignar(ctx, pendientes.map((registro) => ({ registro, motivo: "cola inusualmente grande" })), ahora, desdeMs);
    return { ...resumen, omitido: "cola inusualmente grande" };
  }

  const montos = await montosDe(ctx, pendientes);
  const asociados = ctx.reglas.tipo === "contratos" ? await asociadosDeContratos(ctx, pendientes) : null;
  const opciones: OpcionesReparto = { techo: flujo.conTecho };
  let estado: Estado;
  if (flujo.carga === "abiertos") {
    const carga = await leerCarga(ctx, ahora, desdeMs, new Set(cola.map((r) => r.id)));
    estado = carga.estado;
    opciones.subirMeta = false;
    opciones.ultimoRecibo = carga.ultimoRecibo;
  } else {
    estado = reconstruirEstado(await leerHistorial(ctx, ahora, desdeMs), hoy, competidoresDe(ctx.pool), cal, params);
  }
  const reparto: Reparto = {
    activos: ctx.pool,
    presentes,
    competidores: competidoresDe(presentes),
    estado,
    params,
    opciones,
    nombres: (clave) => ctx.pool.find((a) => a.clave === clave)?.etiqueta ?? clave,
  };

  const ordenados = pendientes
    .map((registro) => ({ registro, monto: montos.get(registro.id) ?? null }))
    .sort((x, y) => (y.monto ?? params.canonTipico) - (x.monto ?? params.canonTipico) || Number(x.registro.id) - Number(y.registro.id));
  const sinAsignar: SinAsignar[] = [];
  const escritas = propiedadesEscritas(flujo);

  for (const { registro, monto } of ordenados) {
    // Lo que tenía el registro antes de escribirlo: queda en el log para que revertir_asignacion.ts lo pueda restaurar.
    let anterior: Record<string, string | null> | null = null;
    let actual: RegistroHS | null = null;
    if (ctx.modo === "activo") {
      const pausaAhora = pausaActiva(flujo);
      if (pausaAhora) return { ...resumen, omitido: `interruptor de apagado activo (${pausaAhora})` };
      // Releer: alguien pudo asignarlo o moverlo mientras tanto, o la búsqueda tardó en reflejar una escritura anterior.
      try {
        actual = await ctx.hs.solicitar<RegistroHS>(
          "GET",
          `/crm/objects/${API}/${cfg.objeto}/${registro.id}?properties=${unicos([...escritas, ...propiedadesCola(flujo, ctx.reglas)]).join(",")}`,
        );
      } catch (error) {
        if (!(error instanceof ErrorHubSpot && error.status === 404)) throw error; // 404: lo borraron o lo fusionaron
      }
      if (actual === null || !cumpleCola(flujo, actual.properties)) {
        const motivo = actual ? "ya no está en la cola (alguien lo asignó o lo movió)" : "el registro ya no existe";
        registrar({ tipo: "omitido", flujo: flujo.clave, modo: ctx.modo, entorno: ctx.entorno, id: registro.id, motivo });
        resumen.omitidos++;
        continue;
      }
      anterior = Object.fromEntries(escritas.map((p) => [p, actual?.properties[p] ?? null]));
    }
    const props = actual?.properties ?? registro.properties;

    const destino =
      ctx.reglas.tipo === "contratos"
        ? destinoContrato(ctx.reglas, datosContrato(props, asociados?.get(registro.id)), monto, reparto)
        : destinoAnalisis(ctx.reglas, props, monto, reparto);
    if (destino.clave === null) {
      sinAsignar.push({ registro, motivo: destino.regla });
      resumen.enEspera++;
      continue;
    }
    const w = destino.decision?.w ?? pesoDeCaso(monto, params);
    if (!destino.decision) contarDirecto(estado, flujo, reparto.competidores, destino.clave, w, params);
    if (monto === null) alerta(flujo, "sin_monto", `El registro ${registro.id} no tiene ${flujo.monto.descripcion}; contó como un caso típico.`, { id: registro.id });

    const elegido = ctx.pool.find((a) => a.clave === destino.clave)!;
    const ownerId = cfg.ownerDeClave.get(destino.clave)!;
    const instante = Date.now();
    if (opciones.ultimoRecibo) opciones.ultimoRecibo[destino.clave] = instante;
    const escrito: Record<string, string> = {
      hubspot_owner_id: ownerId,
      hs_pipeline_stage: cfg.etapaDestino,
      [flujo.propFecha]: new Date(instante).toISOString(),
    };
    // Reasignación (contratos): el registro ya tenía otro propietario, sea o no de la nómina. La primera asignación no
    // cuenta. El ejecutivo anterior solo se anota si es una de las opciones de esa propiedad.
    let reasignacion: { de: string | null; deOwner: string; deNombre: string; anteriorAnotado: boolean } | null = null;
    const previo = props.hubspot_owner_id ?? "";
    const r = flujo.reasignacion;
    if (r && previo && previo !== ownerId) {
      escrito[r.contador] = String((Number(props[r.contador]) || 0) + 1);
      escrito[r.fecha] = escrito[flujo.propFecha];
      const anotado = cfg.opcionesAnterior?.has(previo) ?? false;
      if (anotado) escrito[r.anterior] = previo;
      const de = cfg.claveDeOwner.get(previo) ?? null;
      const deNombre = de ? reparto.nombres(de) : (cfg.nombreDeOwner.get(previo) ?? `el propietario ${previo}`);
      reasignacion = { de, deOwner: previo, deNombre, anteriorAnotado: anotado };
    }
    const d = destino.decision;
    const linea = {
      tipo: "decision",
      flujo: flujo.clave,
      modo: ctx.modo,
      entorno: ctx.entorno,
      objeto: cfg.objeto,
      id: registro.id,
      monto,
      w: redondear(w, 4),
      sinMonto: monto === null,
      regla: destino.regla,
      directo: d === null,
      presentes: presentes.map((a) => a.clave),
      ...(d
        ? {
            respaldo: d.respaldo,
            candidatos: d.candidatos.map((c) => ({ clave: c.clave, delta: redondear(c.delta, 4), e: redondear(c.e, 4), E: redondear(c.E, 4) })),
          }
        : {}),
      elegido: destino.clave,
      ownerId,
      ...(reasignacion ? { reasignacion } : {}),
      // En modo activo: lo que el registro tenía antes y lo que se le escribe, para poder revertirlo.
      ...(anterior ? { anterior, escrito } : {}),
    };

    let escritura = ESCRITURA_SOMBRA;
    if (ctx.modo === "activo") {
      try {
        await ctx.hs.solicitar("PATCH", `/crm/objects/${API}/${cfg.objeto}/${registro.id}`, {
          properties: { ...escrito, asignacion_detalle: textoDetalle(flujo, destino, monto, reparto, instante, reasignacion?.deNombre ?? null) },
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

    // Contratos: el contrato traía otro ejecutivo → tarea para coordinación con el anterior y el nuevo.
    if (reasignacion && cfg.tareaReasignacion) {
      for (const owner of cfg.tareaReasignacion.owners) {
        const tareaEscrita =
          ctx.modo === "activo"
            ? await crearTarea(
                ctx,
                cfg.tareaReasignacion,
                owner,
                registro.id,
                `${flujo.nombre}: registro ${registro.id} reasignado de ${reasignacion.deNombre} a ${elegido.etiqueta}`,
                `El algoritmo de asignación reemplazó el ${flujo.persona} que traía este registro. Antes: ${reasignacion.deNombre}. ` +
                  `Ahora: ${elegido.etiqueta}. Regla: ${destino.regla}.`,
                "MEDIUM",
              )
            : ESCRITURA_SOMBRA;
        registrar({
          tipo: "tarea_reasignacion",
          flujo: flujo.clave,
          modo: ctx.modo,
          entorno: ctx.entorno,
          id: registro.id,
          ownerId: owner.id,
          responsable: owner.nombre,
          de: reasignacion.deOwner,
          a: ownerId,
          escritura: tareaEscrita,
        });
      }
    }
    const como = d ? `Δ ${d.candidatos.find((c) => c.clave === d.elegido)!.delta.toFixed(3)} · ${destino.regla}` : destino.regla;
    console.log(
      `  ${flujo.nombre} #${registro.id}  ${monto === null ? "monto sin dato" : `monto ${cop(monto)}`}  →  ${elegido.etiqueta}  (${como})` +
        `${d?.respaldo ? "  [respaldo: sobre el techo de todos]" : ""}${reasignacion ? `  [reasignación: antes ${reasignacion.deNombre}]` : ""}  [${ctx.modo}]`,
    );
  }
  await avisarSinAsignar(ctx, sinAsignar, ahora, desdeMs);
  return resumen;
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. EJECUCIÓN: CANDADO, ARRANQUE Y BUCLE
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
      // Con nuestro propio PID es de una ejecución anterior: este proceso todavía no lo escribió. Pasa en un contenedor,
      // donde Node suele ser siempre el PID 1 y el candado queda en un volumen si un pod muere a mitad del ciclo.
      if (pid !== process.pid && procesoVivo(pid)) {
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

/** Nómina, parámetros y reglas de un flujo, validados (sin tocar HubSpot). */
function cargarLocal(flujo: Flujo): { todos: Persona[]; pool: Persona[]; params: Parametros; reglas: Reglas } {
  const { todos, pool } = cargarNomina(flujo);
  return { todos, pool, params: cargarParametros(flujo, competidoresDe(pool)), reglas: cargarReglas(flujo, todos) };
}

/** Recarga nómina, parámetros y reglas de cada flujo y revisa HubSpot. Falla si algún flujo no está listo. */
async function prepararContextos(a: Arranque, imprimir: boolean): Promise<Contexto[]> {
  const contextos: Contexto[] = [];
  const fallidos: Flujo[] = [];
  for (const flujo of a.flujos) {
    const { pool, params, reglas } = cargarLocal(flujo);
    if (imprimir) console.log(`\n── ${flujo.nombre} ──`);
    const { cfg } = await diagnosticar(a.hs, flujo, pool, params, reglas, imprimir);
    if (cfg) contextos.push({ flujo, modo: a.modo, entorno: a.entorno, hs: a.hs, cfg, pool, params, reglas, ignorarHorario: a.ignorarHorario });
    else fallidos.push(flujo);
  }
  if (fallidos.length) {
    const listos = a.flujos.filter((f) => !fallidos.includes(f));
    throw new ErrorUso(
      `El diagnóstico de ${fallidos.map((f) => f.nombre).join(" y ")} encontró errores. Se revisan con: node asignacion_equilibrada.ts --diagnostico` +
        (listos.length ? `. Para correr solo lo que está listo, hay que agregar:${listos.map((f) => ` --flujo ${f.clave}`).join("")}` : ""),
    );
  }
  return contextos;
}

function textoResumen(r: ResumenCiclo, modo: Modo): string {
  return (
    `cola ${r.cola}: decididos ${r.decididos}${modo === "activo" ? `, escritos ${r.escritos}` : " (modo sombra: no se escribió nada)"}` +
    `${r.omitidos ? `, omitidos ${r.omitidos}` : ""}${r.enEspera ? `, en espera ${r.enEspera}` : ""}`
  );
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
    // Cada día se recargan nóminas, parámetros y reglas y se revisa HubSpot de nuevo (nuevos propietarios, etapas, etc.).
    if (fechaBogota(inicio) !== fechaDiagnostico) {
      try {
        contextos = await prepararContextos(a, false);
        fechaDiagnostico = fechaBogota(inicio);
      } catch (error) {
        alerta(null, "diagnostico_diario", `No se pudo renovar la configuración; el script sigue con la anterior: ${mensajeDe(error)}`);
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
// 11. PARÁMETROS DESDE AGSSA (--parametros)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Techo T_j (P99 del monto de cada uno), monto típico m̄ y pesos c y s por rol.
 * c = casos por día trabajado y s = monto por día trabajado (en montos típicos), promediados por rol
 * y divididos entre el mayor, igual que en las simulaciones del plan. Con un solo rol, c = s = 1.
 * Quien tiene menos de MIN_CASOS_POR_PERSONA casos queda fuera: sin techo propio y sin pesar en su rol.
 */
export function calcularParametros(casos: CasoHistorico[], pool: Persona[], ventana: { desde: string; hasta: string }): Parametros {
  const porClave = new Map<string, CasoHistorico[]>(pool.map((a) => [a.clave, []]));
  for (const c of casos) if (c.canon > 0) porClave.get(c.clave)?.push(c);
  const conDatos = pool.filter((a) => porClave.get(a.clave)!.length >= MIN_CASOS_POR_PERSONA);
  if (!conDatos.length) {
    throw new ErrorUso(`Nadie tiene ${MIN_CASOS_POR_PERSONA} casos con monto entre ${ventana.desde} y ${ventana.hasta}. Hay que ampliar la ventana con --desde y --hasta.`);
  }
  const todos = conDatos.flatMap((a) => porClave.get(a.clave)!);
  const canonTipico = promedio(todos.map((c) => c.canon));

  const porRol = new Map<Rol, { c: number[]; s: number[] }>();
  const techos: Record<string, number> = {};
  for (const a of conDatos) {
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

/** Casos asignados (persona, fecha de asignación y monto) desde AGSSA con sqlcmd. `hasta` no se incluye. */
function extraerCasosAGSSA(flujo: Flujo, desde: string, hasta: string, pool: Persona[]): { casos: CasoHistorico[]; ultimaFecha: string } {
  const servidor = process.env.AGSSA_SERVIDOR ?? ".\\SQLEXPRESS";
  const base = process.env.AGSSA_BASE ?? "AGSSA_PROD";
  const conDocumento = pool.filter((a) => a.documento);
  const documentos = conDocumento.map((a) => `'${a.documento!.replace(/[^0-9A-Za-z]/g, "")}'`).join(",") || "''";
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
  const claveDe = new Map(conDocumento.map((a) => [a.documento!, a.clave]));
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
    const pool = competidoresDe(cargarNomina(flujo).pool);
    console.log(`${flujo.nombre}: leyendo AGSSA, casos de ${pool.length} ${flujo.personas} del reparto entre ${desde} y ${hasta}…`);
    const { casos, ultimaFecha } = extraerCasosAGSSA(flujo, desde, hasta, pool);
    const atraso = Math.floor((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${ultimaFecha}T00:00:00Z`)) / 86_400_000);
    if (!ultimaFecha || atraso > 15) {
      throw new ErrorUso(`${flujo.nombre}: AGSSA solo tiene asignaciones hasta el ${ultimaFecha || "(sin datos)"} y la ventana termina el ${hasta}: faltan datos recientes. Hay que actualizar la base o indicar --hasta.`);
    }
    const params = calcularParametros(casos, pool, { desde, hasta });
    const sinRol = [...new Set(pool.map((a) => a.rol))].filter((rol) => !params.roles[rol]);
    if (sinRol.length) throw new ErrorUso(`${flujo.nombre}: nadie del rol ${sinRol.join(" ni ")} tiene ${MIN_CASOS_POR_PERSONA} casos en la ventana; no se pueden calcular sus pesos. Hay que ampliarla con --desde.`);
    listos.push({ flujo, pool, params });
  }

  for (const { flujo, pool, params } of listos) {
    const ruta = rutaFlujo(flujo, "parametros.json");
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, JSON.stringify(params, null, 2) + "\n");
    console.log(`\n${flujo.nombre} · m̄ (monto típico, ${flujo.monto.descripcion}): ${cop(params.canonTipico)}   |   casos usados: ${params.calibradoCon.casos}`);
    console.table(
      Object.fromEntries(
        pool.map((a) => [
          a.etiqueta,
          { rol: a.rol, "techo T_j": a.clave in params.techos ? cop(params.techos[a.clave]) : `menos de ${MIN_CASOS_POR_PERSONA} casos`, c: params.roles[a.rol].c, s: params.roles[a.rol].s },
        ]),
      ),
    );
    console.log(`Guardado en ${ruta}`);
  }
  return 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. AUTOPRUEBA (--autoprueba): el motor, las reglas y sus alrededores, sin HubSpot ni AGSSA
// ═════════════════════════════════════════════════════════════════════════════

/** Un zip mínimo (para probar la lectura de .xlsx sin archivos externos). */
function zipDePrueba(archivos: Record<string, string>): Buffer {
  const partes: Buffer[] = [];
  const indice: Buffer[] = [];
  let desplazamiento = 0;
  for (const [nombre, texto] of Object.entries(archivos)) {
    const datos = deflateRawSync(Buffer.from(texto, "utf8"));
    const n = Buffer.from(nombre, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(Buffer.byteLength(texto), 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(Buffer.byteLength(texto), 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(desplazamiento, 42);
    partes.push(local, n, datos);
    indice.push(central, n);
    desplazamiento += 30 + n.length + datos.length;
  }
  const directorio = Buffer.concat(indice);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(indice.length / 2, 8);
  fin.writeUInt16LE(indice.length / 2, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...partes, directorio, fin]);
}

function autoprueba(): number {
  const mulberry32 = (semilla: number) => () => {
    semilla = (semilla + 0x6d2b79f5) | 0;
    let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const persona = (clave: string, rol: Rol, reparto = true, nombre = clave): Persona => ({
    clave,
    etiqueta: clave,
    nombre,
    rol,
    documento: clave,
    ownerId: null,
    correo: null,
    activo: true,
    reparto,
  });
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

  // Para las reglas: un equipo pequeño de cada flujo, con pesos iguales.
  const pIgual: Parametros = { ...p, canonTipico: 2_500_000, roles: { analista: { c: 1, s: 1 }, coordinador: { c: 1, s: 1 }, ejecutivo: { c: 1, s: 1 } }, techos: {} };
  const reparto = (presentes: Persona[], op: OpcionesReparto = { techo: false }, estado?: Estado, activos: Persona[] = presentes): Reparto => ({
    activos,
    presentes,
    competidores: competidoresDe(presentes),
    estado: estado ?? estadoVacio(presentes.map((a) => a.clave)),
    params: pIgual,
    opciones: op,
    nombres: (k) => k,
  });
  const analisis = [persona("miller", "analista"), persona("german", "analista"), persona("monica", "coordinador", false), persona("lorena", "coordinador", false)];
  const reglasR = validarReglasAnalisis(
    { directo: { persona: "monica", montoMayorA: 10_000_000, condiciones: [{ propiedad: "analisis_corredores", valor: "true", motivo: "negocio de corredores" }] } },
    analisis,
    "prueba",
  );
  // e1, e2 y e4 son los de directos; e3 y e5 solo reciben por su clave; ana, solo por su clave.
  const ejecutivos = [
    persona("e1", "ejecutivo"),
    persona("e2", "ejecutivo"),
    persona("e3", "ejecutivo"),
    persona("e4", "ejecutivo"),
    persona("e5", "ejecutivo"),
    persona("ana", "coordinador", false),
  ];
  const reglasC = validarReglasContratos(
    { clavesCompartidas: { "44476": ["e1", "e2"] }, directos: ["e1", "e2", "e4"], tareaReasignacion: { responsables: ["Ana Tavera"] } },
    { claves: { "100": ["e3"], "200": ["ana"], "44476": ["e1"], "500": ["e5"] } },
    { propietarios: [{ cedula: "1.020.304", ejecutivo: "e4" }, { cedula: "900.123.456-7", ejecutivo: "e3" }] },
    ejecutivos,
  );
  const directos = ["e1", "e2", "e4"];
  const sin = (lista: Persona[], ...fuera: string[]) => lista.filter((a) => !fuera.includes(a.clave));
  const contrato = (clave: string | null, cedula: string | null = null, asociados?: { claves: string[]; documentos: string[] }): DatosContrato =>
    datosContrato({ [PROP_CLAVE_ASESOR]: clave, [PROP_CEDULA_PROPIETARIO]: cedula }, asociados);

  const pruebas: [string, () => void][] = [
    ["lo que sube la meta es lo que se reparte: Σe y ΣE no se desvían", () => {
      const azar = mulberry32(1);
      const estado = estadoVacio(claves);
      for (let i = 0; i < 2000; i++) asignarCaso(estado, pool, 1_000_000 + azar() * 12_000_000, p);
      cerca(suma(estado.e), 0, 1e-6);
      cerca(suma(estado.E), 0, 1e-6);
    }],
    ["techo duro: un monto sobre el techo de los analistas siempre va a un coordinador", () => {
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
    ["si el monto supera el techo de todos los presentes va al de mayor techo y se marca el respaldo", () => {
      const d = asignarCaso(estadoVacio(claves), pool.filter((a) => a.clave === "a1" || a.clave === "a2"), 8_000_000, p);
      assert.equal(d.elegido, "a1");
      assert.equal(d.respaldo, true);
    }],
    ["sin techo (el de Análisis desde el 16-nov): los casos de 6 a 10 millones se reparten entre los dos analistas", () => {
      const dos = [persona("a1", "analista"), persona("a3", "analista")];
      const pa: Parametros = { ...p, roles: { analista: { c: 1, s: 1 } } };
      const azar = mulberry32(11);
      const conTecho = estadoVacio(["a1", "a3"]);
      const sinTecho = estadoVacio(["a1", "a3"]);
      const cuenta: Record<string, number> = { a1: 0, a3: 0 };
      for (let i = 0; i < 200; i++) {
        const monto = 6_100_000 + azar() * 3_800_000;
        assert.equal(asignarCaso(conTecho, dos, monto, pa).elegido, "a3"); // con el P99, siempre la misma persona
        cuenta[asignarCaso(sinTecho, dos, monto, pa, { techo: false }).elegido]++;
      }
      assert.ok(cuenta.a1 >= 90 && cuenta.a3 >= 90, `a1 ${cuenta.a1}, a3 ${cuenta.a3}`);
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
    ["un caso sin monto cuenta como típico (w = 1) y se marca", () => {
      const d = asignarCaso(estadoVacio(claves), pool, null, p);
      assert.equal(d.sinCanon, true);
      cerca(d.w, 1);
    }],
    ["un ausente no recibe casos ni acumula deuda", () => {
      const cal: Calendario = { diasLaborales: [1, 2, 3, 4, 5], ausencias: [{ persona: "a4", desde: "2026-11-04", hasta: "2026-11-04" }] };
      const presentes = presentesEn("2026-11-04", pool, cal);
      assert.ok(!presentes.some((a) => a.clave === "a4"));
      const eventos: Evento[] = [0, 1, 2, 3, 4, 5].map((i) => ({ id: String(i), instante: Date.parse(`2026-11-04T08:0${i}:00-05:00`), clave: presentes[i % presentes.length].clave, monto: 3_000_000 }));
      const estado = reconstruirEstado(eventos, "2026-11-04", pool, cal, p);
      assert.equal(estado.e.a4, 0);
      assert.equal(estado.E.a4, 0);
    }],
    ["festivo: sin --ignorar-horario no hay presentes; con él, todos menos quien tenga su propia ausencia", () => {
      const cal: Calendario = {
        diasLaborales: [1, 2, 3, 4, 5],
        ausencias: [{ persona: "*", desde: "2026-11-16", hasta: "2026-11-16" }, { persona: "a2", desde: "2026-11-16", hasta: "2026-11-16" }],
      };
      assert.equal(esDiaLaboral("2026-11-16", cal), false);
      assert.deepEqual(presentesEn("2026-11-16", pool, cal), []);
      assert.deepEqual(presentesEn("2026-11-16", pool, cal, true).map((a) => a.clave), claves.filter((k) => k !== "a2"));
    }],
    ["la memoria: dos días hábiles después los saldos valen 0,9² de lo que valían", () => {
      const eventos: Evento[] = [0, 1, 2, 3].map((i) => ({ id: String(i), instante: Date.parse(`2026-11-02T08:0${i}:00-05:00`), clave: ["a1", "a1", "a2", "c1"][i], monto: 2_000_000 + i * 1_500_000 }));
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
          const monto = azar() < 0.05 ? null : 1_500_000 + azar() * 9_000_000;
          const d = asignarCaso(vivo, presentes, monto, p);
          eventos.push({ id: `${dia}-${i}`, instante: Date.parse(`${dia}T08:${String(i).padStart(2, "0")}:00-05:00`), clave: d.elegido, monto });
        }
      }
      const reconstruido = reconstruirEstado(eventos, "2026-11-04", pool, cal, p);
      for (const k of claves) {
        cerca(reconstruido.e[k], vivo.e[k]);
        cerca(reconstruido.E[k], vivo.E[k]);
      }
    }],
    ["los eventos de quien no está en el reparto se ignoran", () => {
      const estado = reconstruirEstado([{ id: "1", instante: Date.parse("2026-11-02T08:00:00-05:00"), clave: "deicy_p", monto: 2_000_000 }], "2026-11-02", pool, calSemana, p);
      cerca(suma(estado.e), 0);
    }],
    ["monto: solo cuenta lo mayor que cero y legible", () => {
      assert.equal(parsearCanon("3500000"), 3_500_000);
      assert.equal(parsearCanon("3500000.50"), 3_500_000.5);
      for (const malo of [null, undefined, "", "abc", "0", "-5"]) assert.equal(parsearCanon(malo), null);
    }],
    ["monto de Análisis: canon + administración del negocio; si no los trae, el valor canon + admon", () => {
      assert.equal(montoAnalisis({ radicacion_canon: "2700000", radicacion_administracion: "120000", valor_canon___admon: "9" }), 2_820_000);
      assert.equal(montoAnalisis({ radicacion_canon: "2700000", radicacion_administracion: null }), 2_700_000);
      assert.equal(montoAnalisis({ radicacion_canon: null, valor_canon___admon: "2500000" }), 2_500_000);
      assert.equal(montoAnalisis({}), null);
    }],
    ["monto de Análisis: manda la Radicación (la más reciente con dato) sobre la Solicitud y la orden de contrato", () => {
      const m = riesgo.monto;
      const rad = m.pipeline!.id;
      const solicitud = { id: "68029852750", props: { pipeline: "935814405", valor_canon___admon: "9000000" } };
      const orden = { id: "68006464383", props: { pipeline: "949387333" } };
      const radVieja = { id: "68000000001", props: { pipeline: rad, radicacion_canon: "2000000", radicacion_administracion: "0" } };
      const radNueva = { id: "68029789008", props: { pipeline: rad, radicacion_canon: "2300000", radicacion_administracion: "100000" } };
      const radVacia = { id: "68099999999", props: { pipeline: rad } };
      assert.equal(elegirMonto([solicitud, orden, radVieja, radNueva, radVacia], m), 2_400_000);
      assert.equal(elegirMonto([solicitud, orden], m), 9_000_000, "sin Radicación, el asociado que tenga dato");
      assert.equal(elegirMonto([orden], m), null);
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
    ["parámetros: quien tiene menos de 100 casos queda sin techo y no pesa en su rol", () => {
      const tres = [persona("e1", "ejecutivo"), persona("e2", "ejecutivo"), persona("nuevo", "ejecutivo")];
      const casos: CasoHistorico[] = [];
      for (let d = 0; d < 60; d++) {
        const dia = sumarDias("2026-04-01", d);
        for (const k of ["e1", "e2"]) for (let j = 0; j < 2; j++) casos.push({ id: `${k}${d}${j}`, dia, clave: k, canon: 2_000_000 });
        if (d < 10) casos.push({ id: `n${d}`, dia, clave: "nuevo", canon: 90_000_000 });
      }
      const r = calcularParametros(casos, tres, { desde: "2026-04-01", hasta: "2026-05-31" });
      assert.deepEqual(Object.keys(r.techos).sort(), ["e1", "e2"]);
      assert.equal(r.canonTipico, 2_000_000);
      assert.throws(() => calcularParametros(casos.filter((c) => c.clave === "nuevo"), tres, { desde: "2026-04-01", hasta: "2026-05-31" }), /Nadie tiene 100 casos/);
    }],
    ["nombres: el de HubSpot debe estar contenido en el de la nómina (y al revés), con nombre y apellido", () => {
      assert.ok(coincideNombre("GERMAN ANDRES ERAZO FORERO", "Germán Erazo"));
      assert.ok(coincideNombre("Maria Monica Torralba Leuro", "María Torralba"));
      assert.ok(coincideNombre("Eliana Lorena Rojas Castro", "LORENA ROJAS"));
      assert.ok(!coincideNombre("GERMAN ANDRES ERAZO FORERO", "German"));
      assert.ok(!coincideNombre("GERMAN ANDRES ERAZO FORERO", "Eliana Rojas"));
    }],
    ["propietarios: si varios coinciden con el nombre, gana el activo y luego el de nombre idéntico", () => {
      const o = (id: string, firstName: string, lastName: string, userId: number | null) => ({ id, firstName, lastName, userId });
      const calceto = [o("715043408", "Laura", "Calceto", null), o("1129581314", "LAURA JINETH", "CALCETO RODRIGUEZ", 1)];
      assert.deepEqual(desempatarPropietarios(calceto, "Laura Jineth Calceto Rodriguez").map((x) => x.id), ["1129581314"]);
      const dosActivos = [o("1", "Andrea", "Torres", 1), o("2", "Andrea Alanis", "Torres Mendoza", 2)];
      assert.deepEqual(desempatarPropietarios(dosActivos, "Andrea Alanis Torres Mendoza").map((x) => x.id), ["2"]);
      assert.equal(desempatarPropietarios([o("1", "Ana", "Uno", 1), o("2", "Ana", "Uno Dos", 2)], "Ana Uno Dos Tres").length, 2, "si nada desempata, sigue siendo un error");
    }],
    ["un solo rol (ejecutivos): los casos y el monto quedan parejos entre todos", () => {
      const cinco = ["e1", "e2", "e3", "e4", "e5"].map((k) => persona(k, "ejecutivo"));
      const pe: Parametros = { ...p, canonTipico: 2_500_000, roles: { ejecutivo: { c: 1, s: 1 } }, techos: { e1: 9e6, e2: 9e6, e3: 9e6, e4: 9e6, e5: 9e6 } };
      const azar = mulberry32(7);
      const estado = estadoVacio(cinco.map((a) => a.clave));
      for (let i = 0; i < 1000; i++) asignarCaso(estado, cinco, 800_000 + azar() * 5_000_000, pe);
      // Todos presentes y sin memoria: e es casos recibidos − 200 y E es monto recibido − la quinta parte del total.
      assert.ok(rango(estado.e) <= 2 + 1e-9, `casos: diferencia de ${rango(estado.e).toFixed(2)} entre el que más y el que menos`);
      assert.ok(rango(estado.E) <= 2 + 1e-9, `monto: diferencia de ${rango(estado.E).toFixed(2)} montos típicos`);
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
    ["la cola de Análisis: Asignación de analista y lo que aplazó el motor, las dos sin propietario", () => {
      const grupos = filtrosCola(riesgo);
      assert.equal(grupos.length, 2);
      for (const g of grupos) assert.ok(g.filters.some((f) => f.propertyName === "hubspot_owner_id" && f.operator === "NOT_HAS_PROPERTY"));
      assert.ok(grupos[1].filters.some((f) => f.propertyName === "analisis_resultado_motor" && f.value === "Aplazado"));
      const asignacion = riesgo.colas[0].etapa;
      const aplazado = riesgo.colas[1].etapa;
      assert.ok(cumpleCola(riesgo, { hs_pipeline_stage: asignacion, hubspot_owner_id: null }));
      assert.ok(cumpleCola(riesgo, { hs_pipeline_stage: aplazado, analisis_resultado_motor: "Aplazado" }));
      assert.ok(!cumpleCola(riesgo, { hs_pipeline_stage: aplazado, analisis_resultado_motor: null }), "un aplazado de la migración (sin motor) no entra");
      assert.ok(!cumpleCola(riesgo, { hs_pipeline_stage: aplazado, analisis_resultado_motor: "Aplazado", hubspot_owner_id: "9" }));
      assert.ok(!cumpleCola(riesgo, { hs_pipeline_stage: riesgo.destino.etapa }));
    }],
    ["la cola de Contratos: Asignación de ejecutivo, con o sin propietario (el que traiga se reemplaza)", () => {
      const [grupo] = filtrosCola(contratos);
      assert.ok(!grupo.filters.some((f) => f.propertyName === "hubspot_owner_id"));
      assert.deepEqual(grupo.filters.map((f) => f.value), [contratos.pipeline, contratos.colas[0].etapa]);
      assert.ok(cumpleCola(contratos, { hs_pipeline_stage: contratos.colas[0].etapa, hubspot_owner_id: "9" }));
      assert.ok(propiedadesEscritas(contratos).includes("contrato_fechaasignacioncontrato") && !propiedadesEscritas(contratos).includes("fecha_asignacion_analista"));
    }],
    ["fechas oficiales: Análisis escribe analisis_fechaasignacionanalisis; la reversión conoce también la fecha anterior", () => {
      assert.equal(riesgo.propFecha, "analisis_fechaasignacionanalisis");
      assert.ok(propiedadesEscritas(riesgo).includes("analisis_fechaasignacionanalisis") && !propiedadesEscritas(riesgo).includes("fecha_asignacion_analista"));
      for (const p of ["analisis_fechaasignacionanalisis", "contrato_fechaasignacioncontrato", "fecha_asignacion_analista"]) assert.ok(TODAS_LAS_ESCRITAS.includes(p), p);
    }],
    ["ausencias: 'hasta' en null es hasta nuevo aviso; una fecha mal escrita es un error", () => {
      const cal = validarCalendario({ ausencias: [{ persona: "e1", desde: "2026-11-16", hasta: null } as unknown as Ausencia] });
      assert.ok(!presentesEn("2027-06-01", ejecutivos, cal).some((a) => a.clave === "e1"));
      assert.ok(presentesEn("2026-11-13", ejecutivos, cal).some((a) => a.clave === "e1"));
      assert.throws(() => validarCalendario({ ausencias: [{ persona: "e1", desde: "2026-11-16", hasta: "31/12/2026" }] }), /AAAA-MM-DD/);
    }],
    ["objetos: Contratos se reconoce por su nombre exacto y no se confunde con 'Orden de contrato'", () => {
      assert.ok(contratos.esObjeto(normalizar("Contratos")) && contratos.esObjeto(normalizar("Contrato")));
      assert.ok(!contratos.esObjeto(normalizar("Orden de contrato")) && !contratos.esObjeto(normalizar("Análisis de riesgo")));
      assert.ok(riesgo.esObjeto(normalizar("Análisis de riesgo")) && !riesgo.esObjeto(normalizar("Contratos")));
    }],
    ["nómina: el rol tiene que ser de su flujo y tiene que haber alguien activo en el reparto", () => {
      const base = { clave: "x1", nombre: "Xiomara Uno", documento: "1", rol: "ejecutivo" };
      assert.equal(validarNomina({ personas: [base] }, contratos, "prueba").pool.length, 1);
      assert.equal(validarNomina({ personas: [{ ...base, documento: null }] }, contratos, "prueba").pool[0].documento, null);
      assert.throws(() => validarNomina({ personas: [base] }, riesgo, "prueba"), /'rol' debe ser "analista" o "coordinador"/);
      assert.throws(() => validarNomina({ personas: [{ ...base, activo: false }] }, contratos, "prueba"), /no hay ejecutivos activos/);
      assert.throws(() => validarNomina({ personas: [{ ...base, reparto: false }] }, contratos, "prueba"), /ninguno de los ejecutivos activos entra al reparto/);
    }],
    ["Análisis: más de 10 millones va directo a la coordinadora; 10 millones exactos entran al reparto", () => {
      const alto = destinoAnalisis(reglasR, {}, 10_000_001, reparto(analisis));
      assert.equal(alto.clave, "monica");
      assert.equal(alto.decision, null);
      const justo = destinoAnalisis(reglasR, {}, 10_000_000, reparto(analisis));
      assert.ok(justo.clave === "miller" || justo.clave === "german");
      assert.ok(justo.decision);
    }],
    ["Análisis: lo de corredores va directo aunque sea pequeño; nunca le llega a una coordinadora por reparto", () => {
      assert.equal(destinoAnalisis(reglasR, { analisis_corredores: "true" }, 1_500_000, reparto(analisis)).clave, "monica");
      const r = reparto(analisis);
      for (let i = 0; i < 50; i++) {
        const d = destinoAnalisis(reglasR, { analisis_corredores: "false" }, 1_000_000 + i * 150_000, r);
        assert.ok(d.clave === "miller" || d.clave === "german", `fue a ${d.clave}`);
      }
    }],
    ["Análisis: lo directo va a la coordinadora aunque esté ausente (o no haya nadie); solo espera si no está activa", () => {
      const ausente = destinoAnalisis(reglasR, {}, 12_000_000, reparto(sin(analisis, "monica"), undefined, undefined, analisis));
      assert.equal(ausente.clave, "monica");
      assert.match(ausente.regla, /aunque hoy figura ausente/);
      assert.equal(destinoAnalisis(reglasR, { analisis_corredores: "true" }, 1, reparto([], undefined, undefined, analisis)).clave, "monica");
      assert.equal(destinoAnalisis(reglasR, {}, 1_000_000, reparto([], undefined, undefined, analisis)).clave, null, "lo del reparto espera si no hay analistas");
      const inactiva = destinoAnalisis(reglasR, {}, 12_000_000, reparto(sin(analisis, "monica")));
      assert.equal(inactiva.clave, null);
      assert.match(inactiva.regla, /no está activa/);
    }],
    ["Contratos: la clave con un solo ejecutivo manda (aun si el propietario tiene otro); la de Ana Tavera va a ella", () => {
      const d = destinoContrato(reglasC, contrato("100", "1020304"), 3_000_000, reparto(ejecutivos));
      assert.equal(d.clave, "e3");
      assert.equal(d.decision, null);
      assert.match(d.regla, /ejecutivo único/);
      assert.equal(destinoContrato(reglasC, contrato("200"), 3_000_000, reparto(ejecutivos)).clave, "ana", "la clave fija de la coordinadora va a ella");
      assert.equal(destinoContrato(reglasC, contrato("500"), 3_000_000, reparto(ejecutivos)).clave, "e5", "aunque no sea de directos");
    }],
    ["Contratos: si el ejecutivo que corresponde no está, reparto solo entre los de directos presentes", () => {
      const r = reparto(sin(ejecutivos, "e3"));
      for (let i = 0; i < 20; i++) {
        const d = destinoContrato(reglasC, contrato("100"), 3_000_000, r);
        assert.ok(d.decision && directos.includes(d.clave!), `fue a ${d.clave}`);
        assert.match(d.regla, /que no está: reparto entre los ejecutivos de directos/);
      }
      assert.ok(directos.includes(destinoContrato(reglasC, contrato(null, "1020304"), 1, reparto(sin(ejecutivos, "e4"))).clave!));
    }],
    ["Contratos: el propietario con ejecutivo fijo decide si la clave no tiene un solo ejecutivo (basta una cédula de los arrendadores)", () => {
      assert.equal(destinoContrato(reglasC, contrato("999", "001020304"), 3_000_000, reparto(ejecutivos)).clave, "e4");
      assert.equal(destinoContrato(reglasC, contrato("44476", "1020304"), 3_000_000, reparto(ejecutivos)).clave, "e4");
      assert.equal(destinoContrato(reglasC, contrato(null, "1.020.304"), 3_000_000, reparto(ejecutivos)).clave, "e4");
      const varios = contrato(null, null, { claves: [], documentos: ["555", "CC 1.020.304"] });
      assert.equal(destinoContrato(reglasC, varios, 3_000_000, reparto(ejecutivos)).clave, "e4", "el segundo arrendador está en la lista");
      assert.equal(destinoContrato(reglasC, contrato(null, null, { claves: [], documentos: ["900123456-7"] }), 1, reparto(ejecutivos)).clave, "e3", "NIT con dígito de verificación");
      assert.equal(destinoContrato(reglasC, contrato(null, null, { claves: [], documentos: ["900123456"] }), 1, reparto(ejecutivos)).clave, "e3", "NIT sin dígito");
    }],
    ["Contratos: una clave compartida se reparte solo entre sus ejecutivos (manda sobre la tabla); si ninguno está, entre los de directos", () => {
      const r = reparto(ejecutivos);
      const cuenta: Record<string, number> = {};
      for (let i = 0; i < 20; i++) {
        const d = destinoContrato(reglasC, contrato("044476"), 3_000_000, r);
        cuenta[d.clave!] = (cuenta[d.clave!] ?? 0) + 1;
      }
      assert.deepEqual(Object.keys(cuenta).sort(), ["e1", "e2"]);
      assert.equal(destinoContrato(reglasC, contrato("44476"), 3_000_000, reparto(sin(ejecutivos, "e1", "e2"))).clave, "e4");
    }],
    ["Contratos: sin asesor o con una clave fuera de la tabla, reparto solo entre los de directos; sin ninguno, espera", () => {
      const r = reparto(ejecutivos);
      for (let i = 0; i < 30; i++) {
        const d = destinoContrato(reglasC, contrato(i % 2 ? null : "777"), 3_000_000, r);
        assert.ok(d.decision && directos.includes(d.clave!), `fue a ${d.clave}`);
      }
      assert.match(destinoContrato(reglasC, contrato(null), 1, r).regla, /sin asesor/);
      assert.match(destinoContrato(reglasC, contrato("777"), 1, r).regla, /777 sin ejecutivo en la tabla/);
      const espera = destinoContrato(reglasC, contrato(null), 1, reparto(sin(ejecutivos, ...directos)));
      assert.equal(espera.clave, null);
      assert.match(espera.regla, /no hay ningún ejecutivo de directos presente/);
    }],
    ["Contratos: la clave sale del contrato o, si no la trae, del Asesor asociado", () => {
      assert.equal(contrato(null, null, { claves: ["", "100"], documentos: [] }).clave, "100");
      assert.equal(contrato("200", null, { claves: ["100"], documentos: [] }).clave, "200", "la del contrato manda");
      assert.equal(destinoContrato(reglasC, contrato(null, null, { claves: ["100.0"], documentos: [] }), 1, reparto(ejecutivos)).clave, "e3");
    }],
    ["documentos: variantes con prefijo, puntos y dígito de verificación; un documento de prueba no se confunde", () => {
      assert.deepEqual(variantesDocumento("1.020.304"), ["1020304"]);
      assert.deepEqual(variantesDocumento("CC 1.020.304"), ["CC1020304", "1020304"]);
      assert.deepEqual(variantesDocumento("900.123.456-7"), ["9001234567", "900123456"]);
      assert.deepEqual(variantesDocumento("PRUEBA-NGDS-DEV-12345678"), ["PRUEBANGDSDEV12345678"]);
      assert.deepEqual(variantesDocumento(null), []);
      assert.equal(reglasC.totalPropietarios, 2);
      assert.deepEqual(reglasC.tareaReasignacion, { responsables: ["Ana Tavera"] });
    }],
    ["carga en tiempo real: gana quien tiene menos abierto; en empate, quien lleva más tiempo sin recibir", () => {
      const tres = ejecutivos.slice(0, 3);
      const abiertos: Evento[] = [
        { id: "1", instante: 1, clave: "e1", monto: null },
        { id: "2", instante: 2, clave: "e1", monto: null },
        { id: "3", instante: 3, clave: "e1", monto: null },
        { id: "4", instante: 50, clave: "e2", monto: null },
        { id: "5", instante: 10, clave: "e3", monto: null },
      ];
      const { estado, ultimoRecibo } = estadoDeCarga(abiertos, tres.map((a) => a.clave), pIgual);
      assert.deepEqual([estado.e.e1, estado.e.e2, estado.e.e3], [3, 1, 1]);
      const op: OpcionesReparto = { subirMeta: false, techo: false, ultimoRecibo };
      assert.equal(asignarCaso(estado, tres, null, pIgual, op).elegido, "e3", "e2 y e3 empatan; e3 no recibe desde antes");
      ultimoRecibo.e3 = 100;
      assert.equal(asignarCaso(estado, tres, null, pIgual, op).elegido, "e2");
      assert.equal(estado.e.e1, 3, "sin subir la meta, la carga de los demás no cambia");
    }],
    ["códigos: claves y cédulas sin puntos, espacios ni ceros a la izquierda", () => {
      assert.equal(normalizarCodigo("1.020.304.050"), "1020304050");
      assert.equal(normalizarCodigo(" 044476 "), "44476");
      assert.equal(normalizarCodigo(44476), "44476");
      assert.equal(normalizarCodigo("44476.0"), "44476");
      assert.equal(normalizarCodigo(null), "");
    }],
    ["reglas: una clave que no está en la nómina es un error", () => {
      assert.throws(() => validarReglasAnalisis({ directo: { persona: "nadie", montoMayorA: 1 } }, analisis, "prueba"), /no está en la nómina/);
      assert.throws(() => validarReglasContratos({}, { claves: { "1": ["fantasma"] } }, null, ejecutivos), /fantasma/);
      assert.throws(() => validarReglasContratos({}, null, { propietarios: [{ cedula: "1", ejecutivo: "e1" }, { cedula: "001", ejecutivo: "e2" }] }, ejecutivos), /otro ejecutivo fijo/);
      assert.throws(() => validarReglasContratos({ directos: ["e1", "fantasma"] }, null, null, ejecutivos), /directos.*fantasma/);
      assert.throws(() => validarReglasContratos({ directos: ["e1"], tareaReasignacion: { responsables: [] } }, null, null, ejecutivos), /tareaReasignacion/);
      assert.deepEqual(validarReglasContratos({}, null, null, ejecutivos).directos, [], "sin 'directos' carga, pero el diagnóstico no deja arrancar");
    }],
    ["tabla de asesores (CSV): encuentra las columnas, junta las claves compartidas y avisa los nombres que no conoce", () => {
      const equipo = [
        persona("andrea_torres", "ejecutivo", true, "Andrea Alanis Torres Mendoza"),
        persona("luz_castellanos", "ejecutivo", true, "Luz Andrea Castellanos Perez"),
        persona("laura_castro", "ejecutivo", true, "Laura Daniela Castro Urrego"),
      ];
      const csv = "Listado de noviembre;;;\nOficina;CLAVE ASESOR;Nombre asesor;EJECUTIVO\nVen Ser;100;Pedro;ANDREA ALANIS TORRES MENDOZA\nProsear;044476;Inmo;Luz Andrea Castellanos Pérez\nProsear;44476;Inmo;Laura Castro\nOtra;300;Z;Fulano De Tal\nOtra;400;Y;Luz Andrea Castellanos / Laura Castro\n";
      const t = tablaDeAsesores([filasDeCsv(csv)], equipo);
      assert.deepEqual(t.claves["100"], ["andrea_torres"]);
      assert.deepEqual(t.claves["44476"], ["laura_castro", "luz_castellanos"]);
      assert.deepEqual(t.claves["400"], ["laura_castro", "luz_castellanos"]);
      assert.deepEqual(t.noReconocidos, ["Fulano De Tal"]);
      assert.equal(t.filas, 5);
    }],
    ["xlsx: lee textos compartidos, números, celdas en línea y columnas salteadas", () => {
      const buf = zipDePrueba({
        "xl/sharedStrings.xml": '<sst><si><t>CLAVE ASESOR</t></si><si><r><t>EJE</t></r><r><t xml:space="preserve">CUTIVO</t></r></si><si><t>Luz &amp; Laura</t></si></sst>',
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"/>' +
          '<row r="3"><c r="A3"><v>44476</v></c><c r="B3" s="1"/><c r="C3" t="s"><v>2</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>99999</t></is></c></row></sheetData></worksheet>',
      });
      assert.deepEqual(hojasDeXlsx(buf), [[["CLAVE ASESOR", "", "EJECUTIVO"], [], ["44476", "", "Luz & Laura"], ["99999"]]]);
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
// 13. PUNTO DE ENTRADA
// ═════════════════════════════════════════════════════════════════════════════

const AYUDA = `Asignación equilibrada (motor ${VERSION_MOTOR}): ${FLUJOS.map((f) => f.nombre).join(" y ")}

  node asignacion_equilibrada.ts                  ciclo continuo cada 2 min en MODO SOMBRA (no escribe en HubSpot)
  node asignacion_equilibrada.ts --activar        igual, pero escribe en HubSpot
  node asignacion_equilibrada.ts --una-vez        un solo ciclo y termina (n8n o Programador de tareas); fuera de horario,
                                                  en pausa o con otra ejecución en curso sale con 0 sin tocar HubSpot
  node asignacion_equilibrada.ts --diagnostico    revisa token, scopes, objetos, etapas, propiedades, reglas y propietarios
  node asignacion_equilibrada.ts --parametros     recalcula data/<flujo>/parametros.json desde AGSSA [--desde AAAA-MM-DD --hasta AAAA-MM-DD]
  node asignacion_equilibrada.ts --importar-asesores <archivo.xlsx|.csv>
                                                  convierte el Excel de Ana (clave del asesor → ejecutivo) en data/contratos/asesores.json
  node asignacion_equilibrada.ts --autoprueba     pruebas del motor y de las reglas

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
        "importar-asesores": { type: "string" },
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
  if (valores["importar-asesores"] !== undefined) return importarAsesores(valores["importar-asesores"]);

  const flujos = elegirFlujos(valores.flujo);
  cargarEnv();
  if (valores.parametros) return generarParametros(flujos, valores.desde, valores.hasta);

  // Antes de tocar HubSpot: la nómina, los parámetros y las reglas de cada flujo deben estar bien.
  for (const flujo of flujos) cargarLocal(flujo);
  const { entorno, token } = elegirEntorno(valores.produccion === true);
  const hs = crearCliente(token, urlBase());

  if (valores.diagnostico) {
    console.log(`Diagnóstico en ${entorno} (API ${API})`);
    let listos = 0;
    for (const flujo of flujos) {
      console.log(`\n── ${flujo.nombre} ──`);
      const { pool, params, reglas } = cargarLocal(flujo);
      const { cfg } = await diagnosticar(hs, flujo, pool, params, reglas, true);
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
  for (const ctx of contextos) console.log(`${ctx.flujo.nombre}: ${resumenEquipo(ctx.pool, ctx.reglas, ctx.flujo.personas)}`);
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
