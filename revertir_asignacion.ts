/**
 * Revierte lo que hizo asignacion_equilibrada.ts. Es para la fase de pruebas.
 *
 * Uso (Node 24, sin dependencias):
 *   node revertir_asignacion.ts              muestra qué se revertiría, sin cambiar nada
 *   node revertir_asignacion.ts --aplicar    lo revierte
 *   Filtros: --flujo analisis_riesgo|contratos (se puede repetir), --desde AAAA-MM-DD (decisiones de ese día en
 *   adelante, hora de Colombia) e --id <registro> (se puede repetir). Por defecto trabaja en el sandbox; --produccion
 *   usa HUBSPOT_TOKEN.
 *
 * Qué revierte, a partir de logs/decisiones.jsonl:
 *   - Lo que escribió el modo activo: a cada registro le devuelve el propietario, la etapa, fecha_asignacion_analista
 *     y asignacion_detalle que tenía antes de la asignación. Solo si sigue como lo dejó el script (mismo propietario,
 *     misma etapa y misma fecha): si alguien lo cambió después, no lo toca y lo informa.
 *   - Lo que decidió el modo sombra: en HubSpot no hay nada que deshacer. Se saca del log para que el modo sombra lo
 *     vuelva a decidir.
 * Lo revertido sale de logs/decisiones.jsonl y pasa a logs/revertidas.jsonl, con el resultado de cada uno.
 *
 * No deshace lo que HubSpot haya hecho por su cuenta con esos cambios (workflows, notificaciones o tareas). El
 * historial de cada propiedad conserva la asignación y la reversión.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  ErrorHubSpot,
  ErrorUso,
  FLUJOS,
  PROPIEDADES_ESCRITAS,
  RUTA,
  cargarEnv,
  crearCliente,
  elegirEntorno,
  fechaBogota,
  parsearInstante,
  tomarCandado,
  urlBase,
  type ClienteHS,
  type RegistroHS,
} from "./asignacion_equilibrada.ts";

const ARCHIVO_REVERTIDAS = join(dirname(RUTA.log), "revertidas.jsonl");
const TOLERANCIA_FECHA_MS = 1000;

type Valores = Record<string, string | null>;

interface Decision {
  tipo: "decision";
  fecha: string;
  flujo: string;
  modo: "sombra" | "activo";
  entorno: string;
  objeto?: string;
  id: string;
  escritura: string;
  anterior?: Valores;
  escrito?: Valores;
}

interface Paso {
  indice: number;
  d: Decision;
  accion: "restaurar" | "sacar" | "dejar";
  motivo: string;
  resultado?: string;
}

const AYUDA = `Revierte lo que hizo asignacion_equilibrada.ts (fase de pruebas)

  node revertir_asignacion.ts              muestra qué se revertiría, sin cambiar nada
  node revertir_asignacion.ts --aplicar    lo revierte

  --flujo <clave>      solo ese flujo (${FLUJOS.map((f) => f.clave).join(" o ")}); se puede repetir. Por defecto, todos
  --desde AAAA-MM-DD   solo las decisiones de ese día en adelante (hora de Colombia)
  --id <registro>      solo ese registro; se puede repetir
  --produccion         usa HUBSPOT_TOKEN en lugar de HUBSPOT_TOKEN_SANDBOX
`;

const mensajeDe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const vacio = (v: string | null | undefined) => v === null || v === undefined || v === "";
const horaLocal = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
const nombreFlujo = (clave: string) => FLUJOS.find((f) => f.clave === clave)?.nombre ?? clave;

const mismaFecha = (a: string | null | undefined, b: string | null | undefined) => {
  const x = parsearInstante(a);
  const y = parsearInstante(b);
  return x !== null && y !== null && Math.abs(x - y) <= TOLERANCIA_FECHA_MS;
};

/** El registro sigue como lo dejó el script. */
const comoLoDejo = (v: Valores, escrito: Valores) =>
  v.hubspot_owner_id === escrito.hubspot_owner_id &&
  v.hs_pipeline_stage === escrito.hs_pipeline_stage &&
  mismaFecha(v.fecha_asignacion_analista, escrito.fecha_asignacion_analista);

/** El registro ya está como antes de la asignación (la escritura falló o ya se revirtió). */
const comoEstaba = (v: Valores, anterior: Valores) =>
  (v.hubspot_owner_id ?? "") === (anterior.hubspot_owner_id ?? "") &&
  v.hs_pipeline_stage === anterior.hs_pipeline_stage &&
  (vacio(anterior.fecha_asignacion_analista)
    ? vacio(v.fecha_asignacion_analista)
    : mismaFecha(v.fecha_asignacion_analista, anterior.fecha_asignacion_analista));

function queCambio(v: Valores, escrito: Valores): string {
  const cambios = [
    v.hubspot_owner_id !== escrito.hubspot_owner_id ? "el propietario" : null,
    v.hs_pipeline_stage !== escrito.hs_pipeline_stage ? "la etapa" : null,
    !mismaFecha(v.fecha_asignacion_analista, escrito.fecha_asignacion_analista) ? "la fecha de asignación" : null,
  ].filter(Boolean);
  return cambios.join(", ");
}

/** Lo que se le escribe al registro para dejarlo como estaba. Una etapa no se puede dejar vacía. */
function cuerpoRestauracion(anterior: Valores): Record<string, string> {
  const props: Record<string, string> = {};
  for (const p of PROPIEDADES_ESCRITAS) {
    if (p === "hs_pipeline_stage" && vacio(anterior[p])) continue;
    props[p] = anterior[p] ?? "";
  }
  return props;
}

/** Nombres de propietarios y etapas para mostrar el plan; si HubSpot no responde, se muestran los ids. */
async function etiquetas(hs: ClienteHS, objetos: string[]) {
  const propietarios = new Map<string, string>();
  const etapas = new Map<string, string>();
  try {
    let after: string | undefined;
    do {
      const pagina = await hs.solicitar<{
        results: { id: string; firstName?: string; lastName?: string; email?: string }[];
        paging?: { next?: { after: string } };
      }>("GET", `/crm/v3/owners?limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      for (const o of pagina.results) propietarios.set(o.id, `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email || o.id);
      after = pagina.paging?.next?.after;
    } while (after);
  } catch {
    // Sin nombres de propietarios: se muestran los ids.
  }
  for (const objeto of objetos) {
    try {
      const { results } = await hs.solicitar<{ results: { stages: { id: string; label: string }[] }[] }>("GET", `/crm/v3/pipelines/${objeto}`);
      for (const p of results) for (const s of p.stages) etapas.set(s.id, s.label);
    } catch {
      // Sin nombres de etapas: se muestran los ids.
    }
  }
  return {
    propietario: (id: string | null | undefined) => (vacio(id) ? "sin propietario" : (propietarios.get(id!) ?? id!)),
    etapa: (id: string | null | undefined) => (vacio(id) ? "sin etapa" : (etapas.get(id!) ?? id!)),
  };
}

async function main(argumentos: string[]): Promise<number> {
  let valores;
  try {
    ({ values: valores } = parseArgs({
      args: argumentos,
      strict: true,
      options: {
        aplicar: { type: "boolean" },
        produccion: { type: "boolean" },
        flujo: { type: "string", multiple: true },
        desde: { type: "string" },
        id: { type: "string", multiple: true },
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

  const flujos = valores.flujo?.length ? valores.flujo : FLUJOS.map((f) => f.clave);
  for (const clave of flujos) {
    if (!FLUJOS.some((f) => f.clave === clave)) throw new ErrorUso(`El flujo "${clave}" no existe. Los flujos son: ${FLUJOS.map((f) => f.clave).join(", ")}.`);
  }
  const desde = valores.desde;
  if (desde !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new ErrorUso("--desde debe ser AAAA-MM-DD.");
  const ids = valores.id ?? [];
  const aplicar = valores.aplicar === true;
  const produccion = valores.produccion === true;
  const entorno = produccion ? "produccion" : "sandbox";

  cargarEnv();
  // Al aplicar, el candado garantiza que la asignación no esté corriendo mientras se reescribe su log.
  if (aplicar) {
    try {
      tomarCandado();
    } catch (error) {
      if (error instanceof ErrorUso) throw new ErrorUso(`No se puede revertir mientras corre la asignación. ${error.message}`);
      throw error;
    }
  }

  const lineas = existsSync(RUTA.log) ? readFileSync(RUTA.log, "utf8").split("\n").filter((t) => t !== "") : [];
  const decisiones = lineas.map((texto, indice) => {
    try {
      const l = JSON.parse(texto);
      return l?.tipo === "decision" ? { indice, d: l as Decision } : null;
    } catch {
      return null; // Línea dañada: se conserva tal cual.
    }
  });
  const elegidas = decisiones
    .filter((x): x is { indice: number; d: Decision } => x !== null)
    .filter(({ d }) => d.entorno === entorno && flujos.includes(d.flujo) && (!desde || fechaBogota(Date.parse(d.fecha)) >= desde) && (!ids.length || ids.includes(d.id)))
    // De la más reciente a la más vieja: si un registro se asignó dos veces, se deshace primero la última.
    .sort((a, b) => Date.parse(b.d.fecha) - Date.parse(a.d.fecha) || b.indice - a.indice);

  const aviso = aplicar ? "REVIERTE" : "solo revisión: no cambia nada (para hacerlo: --aplicar)";
  console.log(`Reversión en ${entorno} · ${aviso}\n`);
  if (!elegidas.length) {
    console.log(`No hay decisiones que revertir en ${entorno} con esos filtros.`);
    return 0;
  }

  // El cliente solo hace falta si hay escrituras del modo activo.
  let cliente: ClienteHS | null = null;
  const hs = () => (cliente ??= crearCliente(elegirEntorno(produccion).token, urlBase()));

  // Estado de cada registro: se lee una vez y se actualiza con lo que se va restaurando, para que dos asignaciones
  // del mismo registro se evalúen en orden.
  const actuales = new Map<string, Valores | "no existe">();
  async function leerActual(objeto: string, id: string): Promise<Valores | "no existe"> {
    const clave = `${objeto}/${id}`;
    const guardado = actuales.get(clave);
    if (guardado) return guardado;
    let valor: Valores | "no existe";
    try {
      const r = await hs().solicitar<RegistroHS>("GET", `/crm/v3/objects/${objeto}/${id}?properties=${PROPIEDADES_ESCRITAS.join(",")}`);
      valor = Object.fromEntries(PROPIEDADES_ESCRITAS.map((p) => [p, r.properties[p] ?? null]));
    } catch (error) {
      if (!(error instanceof ErrorHubSpot && error.status === 404)) throw error;
      valor = "no existe";
    }
    actuales.set(clave, valor);
    return valor;
  }

  const pasos: Paso[] = [];
  for (const { indice, d } of elegidas) {
    if (d.modo === "sombra") {
      pasos.push({ indice, d, accion: "sacar", motivo: "decisión del modo sombra: se olvida para que se vuelva a decidir" });
      continue;
    }
    if (!d.objeto || !d.anterior || !d.escrito) {
      pasos.push({ indice, d, accion: "dejar", motivo: "la decisión no guardó lo que el registro tenía antes: hay que revertirlo a mano" });
      continue;
    }
    const actual = await leerActual(d.objeto, d.id);
    if (actual === "no existe") {
      pasos.push({ indice, d, accion: "sacar", motivo: "el registro ya no existe en HubSpot" });
    } else if (comoLoDejo(actual, d.escrito)) {
      pasos.push({ indice, d, accion: "restaurar", motivo: "" });
      actuales.set(`${d.objeto}/${d.id}`, { ...d.anterior });
    } else if (comoEstaba(actual, d.anterior)) {
      const motivo = d.escritura === "ok" ? "ya estaba como antes de la asignación" : "la escritura había fallado: HubSpot no cambió";
      pasos.push({ indice, d, accion: "sacar", motivo });
    } else {
      pasos.push({ indice, d, accion: "dejar", motivo: `cambió después de la asignación (${queCambio(actual, d.escrito)}): no se toca` });
    }
  }

  const objetos = [...new Set(pasos.filter((p) => p.accion === "restaurar").map((p) => p.d.objeto!))];
  const nombres = objetos.length ? await etiquetas(hs(), objetos) : null;
  for (const p of pasos) {
    if (p.accion !== "restaurar" || !nombres) continue;
    const { anterior, escrito } = p.d as Required<Decision>;
    const fechaYDetalle = vacio(anterior.fecha_asignacion_analista) && vacio(anterior.asignacion_detalle) ? "vacíos" : "los de antes";
    p.motivo =
      `propietario ${nombres.propietario(escrito.hubspot_owner_id)} → ${nombres.propietario(anterior.hubspot_owner_id)} · ` +
      `etapa ${nombres.etapa(escrito.hs_pipeline_stage)} → ${nombres.etapa(anterior.hs_pipeline_stage)} · fecha y detalle → ${fechaYDetalle}`;
  }

  // Aplicar, en el mismo orden en que se evaluó. Si falla un registro, no se tocan sus asignaciones más viejas.
  let fallas = 0;
  if (aplicar) {
    const fallidos = new Set<string>();
    for (const p of pasos) {
      if (p.accion !== "restaurar") continue;
      const clave = `${p.d.objeto}/${p.d.id}`;
      if (fallidos.has(clave)) {
        p.resultado = "no se intentó: falló la reversión más reciente del mismo registro";
        fallas++;
        continue;
      }
      try {
        await hs().solicitar("PATCH", `/crm/v3/objects/${p.d.objeto}/${p.d.id}`, { properties: cuerpoRestauracion(p.d.anterior!) });
        p.resultado = "restaurado";
      } catch (error) {
        p.resultado = `error: ${mensajeDe(error)}`;
        fallidos.add(clave);
        fallas++;
      }
    }
  }

  const titulo = { restaurar: aplicar ? "Restaurado" : "Se restauraría", sacar: aplicar ? "Se olvidó" : "Se olvidaría", dejar: "No se toca" };
  for (const p of pasos) {
    const estado = p.resultado && p.resultado !== "restaurado" ? `FALLÓ (${p.resultado})` : titulo[p.accion];
    console.log(`  ${nombreFlujo(p.d.flujo)} #${p.d.id} · ${p.d.modo} · ${horaLocal(p.d.fecha)}`);
    console.log(`      ${estado}${p.motivo ? `: ${p.motivo}` : ""}`);
  }

  const cuenta = (accion: Paso["accion"]) => pasos.filter((p) => p.accion === accion && (!p.resultado || p.resultado === "restaurado")).length;
  const restaurados = cuenta("restaurar");
  const olvidados = cuenta("sacar");
  const dejados = pasos.filter((p) => p.accion === "dejar").length;

  if (!aplicar) {
    console.log(
      `\nSe restaurarían ${restaurados} registro(s), se olvidarían ${olvidados} decisión(es) y ${dejados} no se tocan. ` +
        "Para hacerlo, el mismo comando con --aplicar.",
    );
    return 0;
  }

  // Sale del log lo que se revirtió o se olvidó; queda en revertidas.jsonl con su resultado.
  const quitar = pasos.filter((p) => p.accion === "sacar" || p.resultado === "restaurado");
  if (quitar.length) {
    const indices = new Set(quitar.map((p) => p.indice));
    const quedan = lineas.filter((_, i) => !indices.has(i));
    const temporal = `${RUTA.log}.tmp`;
    writeFileSync(temporal, quedan.length ? `${quedan.join("\n")}\n` : "");
    renameSync(temporal, RUTA.log);
    const ahora = new Date().toISOString();
    appendFileSync(
      ARCHIVO_REVERTIDAS,
      quitar.map((p) => JSON.stringify({ ...JSON.parse(lineas[p.indice]), revertidoEl: ahora, resultado: p.resultado ?? p.motivo })).join("\n") + "\n",
    );
  }
  appendFileSync(
    RUTA.log,
    JSON.stringify({ fecha: new Date().toISOString(), tipo: "reversion", entorno, flujos, desde: desde ?? null, ids, restaurados, olvidados, noTocados: dejados, fallas }) + "\n",
  );
  console.log(
    `\nSe restauraron ${restaurados} registro(s), se olvidaron ${olvidados} decisión(es) y ${dejados} no se tocaron` +
      `${fallas ? `; ${fallas} fallaron` : ""}. El detalle quedó en logs/revertidas.jsonl.`,
  );
  return fallas ? 1 : 0;
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
