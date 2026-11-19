// Pruebas de punta a punta del motor v2 (reglas del 16-nov) contra un HubSpot simulado (API 2026-09, en localhost).
// No toca HubSpot ni AGSSA: cada escenario copia los scripts a logs/e2e/<n>/ con sus propios data/ y logs/.
// Uso: npm run e2e   (o node pruebas/e2e.mjs)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { iniciarMock, OWNERS as O, R, C } from "./mock_hubspot.mjs";

const proyecto = path.dirname(import.meta.dirname);
const base = path.join(proyecto, "logs", "e2e");
fs.rmSync(base, { recursive: true, force: true });
const hoy = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const hace = (min) => new Date(Date.now() - min * 60_000).toISOString();
const p = (clave, nombre, rol, extra = {}) => ({ clave, etiqueta: clave, nombre, rol, documento: String(clave.length), ownerId: null, correo: null, activo: true, reparto: true, ...extra });
const DIRECTOS = ["e_b", "e_c", "e_d"];

const DATOS = {
  "analisis_riesgo/nomina.json": { personas: [p("miller", "Miller Soriano", "analista"), p("german", "German Erazo", "analista"), p("monica", "Maria Monica Torralba", "coordinador", { reparto: false }), p("lorena", "Lorena Rojas", "coordinador", { reparto: false })] },
  "analisis_riesgo/parametros.json": { generado: "e2e", calibradoCon: { desde: hoy, hasta: hoy, casos: 500 }, canonTipico: 2_500_000, roles: { analista: { c: 1, s: 1 }, coordinador: { c: 1, s: 1 } }, techos: {} },
  "analisis_riesgo/reglas.json": { directo: { persona: "monica", montoMayorA: 10_000_000, condiciones: [{ propiedad: "analisis_corredores", valor: "true", motivo: "negocio de corredores" }] } },
  "contratos/nomina.json": {
    personas: [
      p("e_a", "Ejecutiva Alfa", "ejecutivo"), p("e_b", "Ejecutivo Beta", "ejecutivo"), p("e_c", "Ejecutiva Gama", "ejecutivo"), p("e_d", "Ejecutivo Delta", "ejecutivo"),
      p("e_e", "Ejecutiva Epsilon", "ejecutivo"), p("ana_t", "Ana Leonor Tavera Leal", "coordinador", { reparto: false }),
    ],
  },
  "contratos/parametros.json": { generado: "e2e", calibradoCon: { desde: hoy, hasta: hoy, casos: 500 }, canonTipico: 2_000_000, roles: { ejecutivo: { c: 1, s: 1 }, coordinador: { c: 1, s: 1 } }, techos: {} },
  "contratos/reglas.json": {
    clavesCompartidas: { "44476": ["e_b", "e_c"] },
    directos: DIRECTOS,
    tareaSinAsignar: { minutos: 3, responsables: ["Olga Janneth Sanchez Cortes", "Ana Leonor Tavera Leal"] },
    tareaReasignacion: { responsables: ["Ana Leonor Tavera Leal"] },
  },
  "contratos/asesores.json": { fuente: "e2e", importado: hoy, claves: { "100": ["e_a"], "200": ["ana_t"], "300": ["e_e"] } },
  "contratos/propietarios.json": { propietarios: [{ cedula: "555", ejecutivo: "e_d" }] },
  "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: [] },
};

let n = 0;
const resultados = [];
async function escenario(nombre, fn, ajustes = {}) {
  const M = await iniciarMock();
  const dir = path.join(base, String(++n));
  for (const [rel, contenido] of Object.entries({ ...DATOS, ...ajustes })) {
    fs.mkdirSync(path.dirname(path.join(dir, "data", rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", rel), JSON.stringify(contenido, null, 2));
  }
  for (const s of ["asignacion_equilibrada.ts", "revertir_asignacion.ts"]) fs.copyFileSync(path.join(proyecto, s), path.join(dir, s));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const lanzar = (script, args) => new Promise((ok) => {
    const hijo = spawn(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, HUBSPOT_API_URL: M.url, HUBSPOT_TOKEN_SANDBOX: "fake", HUBSPOT_TOKEN: "" } });
    let salida = "";
    hijo.stdout.on("data", (c) => (salida += c));
    hijo.stderr.on("data", (c) => (salida += c));
    hijo.on("close", (codigo) => ok({ codigo, salida }));
  });
  const log = () => (fs.existsSync(path.join(dir, "logs", "decisiones.jsonl")) ? fs.readFileSync(path.join(dir, "logs", "decisiones.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ctx = { M, dir, correr: (args) => lanzar("asignacion_equilibrada.ts", args), revertir: (args) => lanzar("revertir_asignacion.ts", args), log, escribirLog: (l) => { fs.mkdirSync(path.join(dir, "logs"), { recursive: true }); fs.appendFileSync(path.join(dir, "logs", "decisiones.jsonl"), JSON.stringify(l) + "\n"); } };
  try {
    await fn(ctx);
    resultados.push(["ok", nombre]);
  } catch (error) {
    resultados.push(["FALLA", nombre, error.message]);
  } finally {
    await M.cerrar();
  }
}
const props = (M, objeto, id) => (objeto === R.objeto ? M.riesgo : M.contratos).registros.get(String(id)).properties;
const salidaOk = (r) => assert.equal(r.codigo, 0, `código ${r.codigo}:\n${r.salida}`);
// Sin --ignorar-horario: desde el 19-nov el script corre a cualquier hora, también fines de semana y festivos.
const ACTIVO = ["--una-vez", "--activar"];
const ownerDe = (clave) => O[clave];

await escenario("diagnóstico completo en la simulación", async ({ correr }) => {
  const r = await correr(["--diagnostico"]);
  salidaOk(r);
  assert.match(r.salida, /Todo listo/);
  assert.match(r.salida, /tarea para Olga Janneth Sanchez Cortes y Ana Leonor Tavera Leal/);
  assert.match(r.salida, /Si un contrato traía otro ejecutivo, tarea para Ana Leonor Tavera Leal/);
  assert.match(r.salida, /asesor_clave del Asesor asociado \(2-400\)/);
  assert.match(r.salida, /contactos "Arrendador Cto" \(tipo 439\)/);
  assert.match(r.salida, /Radicación \(0-3, pipeline 935981686\)/);
  assert.match(r.salida, /Directo a monica, aunque esté ausente/);
  assert.match(r.salida, /contrato_ejecutivo_anterior \(de tipo propietario\)/);
  assert.doesNotMatch(r.salida, /no tiene como opción/);
});

await escenario("diagnóstico: sin 'directos' en las reglas de Contratos no arranca", async ({ correr }) => {
  const r = await correr(["--diagnostico", "--flujo", "contratos"]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.salida, /Falta 'directos'/);
}, { "contratos/reglas.json": { clavesCompartidas: { "44476": ["e_b", "e_c"] } } });

await escenario("Análisis: monto de la Radicación (por la Solicitud o directa); directo a Mónica por monto y corredores; reparto del resto; fecha oficial; reversión", async ({ M, correr, revertir }) => {
  M.analisis(1, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "11000000", radicacion_administracion: "500000" }); // por la Solicitud
  M.analisis(2, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "2000000", radicacion_administracion: "200000" }, { directo: true });
  M.analisis(3, { hs_pipeline_stage: R.aplazado, analisis_resultado_motor: "Aplazado" }, { radicacion_canon: "3000000" });
  M.analisis(4, { hs_pipeline_stage: R.aplazado }); // aplazado de la migración: no entra
  M.analisis(5, { hs_pipeline_stage: R.aplazado, analisis_resultado_motor: "Aplazado", hubspot_owner_id: O.otro }); // ya tiene dueño: no entra
  M.analisis(6, { hs_pipeline_stage: R.asignacion, analisis_corredores: "true" }, { radicacion_canon: "1000000" });
  M.analisis(7, { hs_pipeline_stage: R.asignacion }); // sin negocio: sin monto
  M.analisis(8, { hs_pipeline_stage: R.tramite, hubspot_owner_id: O.miller, analisis_fechaasignacionanalisis: hace(60) }, { radicacion_canon: "9000000" }); // historial de Miller
  M.analisis(9, { hs_pipeline_stage: R.tramite, hubspot_owner_id: O.german, fecha_asignacion_analista: hace(60) }, { radicacion_canon: "9000000" }); // fecha vieja: ya no cuenta
  const r = await correr([...ACTIVO, "--flujo", "analisis_riesgo"]);
  salidaOk(r);
  const escritos = new Set(M.patches(R.objeto).map((l) => l.ruta.split("/").pop()));
  assert.deepEqual([...escritos].sort(), ["1", "2", "3", "6", "7"]);
  for (const id of [1, 6]) assert.equal(props(M, R.objeto, id).hubspot_owner_id, O.monica, `#${id}`);
  for (const id of [2, 3, 7]) assert.ok([O.miller, O.german].includes(props(M, R.objeto, id).hubspot_owner_id), `#${id}`);
  assert.equal(props(M, R.objeto, 3).hubspot_owner_id, O.german, "el aplazado de 3M va a Germán: Miller tiene 9M en el historial (fecha oficial)");
  for (const id of [1, 2, 3, 6, 7]) {
    assert.equal(props(M, R.objeto, id).hs_pipeline_stage, R.tramite);
    assert.ok(props(M, R.objeto, id).analisis_fechaasignacionanalisis, `#${id} sin fecha oficial`);
    assert.equal(props(M, R.objeto, id).fecha_asignacion_analista ?? null, null, `#${id} no debe escribir la fecha vieja`);
  }
  assert.match(props(M, R.objeto, 1).asignacion_detalle, /regla: directo a monica: monto mayor que 10\.000\.000/);
  assert.match(props(M, R.objeto, 1).asignacion_detalle, /canon \+ administración 11\.500\.000/, "monto de la Radicación a la que se llega por la Solicitud");
  assert.match(props(M, R.objeto, 2).asignacion_detalle, /canon \+ administración 2\.200\.000/);
  assert.match(props(M, R.objeto, 6).asignacion_detalle, /negocio de corredores/);
  assert.equal(props(M, R.objeto, 4).hs_pipeline_stage, R.aplazado);
  assert.equal(props(M, R.objeto, 5).hubspot_owner_id, O.otro);

  const v = await revertir(["--aplicar", "--flujo", "analisis_riesgo"]);
  salidaOk(v);
  assert.match(v.salida, /Se restauraron 5 registro/);
  assert.equal(props(M, R.objeto, 3).hs_pipeline_stage, R.aplazado, "el aplazado vuelve a Aplazado");
  for (const id of [1, 2, 3, 6, 7]) {
    assert.equal(props(M, R.objeto, id).hubspot_owner_id, null);
    assert.equal(props(M, R.objeto, id).analisis_fechaasignacionanalisis, null);
  }
});

await escenario("Análisis: Mónica ausente → lo directo igual va a ella", async ({ M, correr }) => {
  M.analisis(1, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "12000000" });
  M.analisis(2, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "2000000" });
  salidaOk(await correr([...ACTIVO, "--flujo", "analisis_riesgo"]));
  assert.equal(props(M, R.objeto, 1).hubspot_owner_id, O.monica);
  assert.match(props(M, R.objeto, 1).asignacion_detalle, /aunque hoy figura ausente/);
  assert.ok([O.miller, O.german].includes(props(M, R.objeto, 2).hubspot_owner_id));
}, { "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: [{ persona: "monica", desde: hoy, hasta: null }] } });

await escenario("Análisis: nadie presente → lo directo va a Mónica; lo demás espera (una línea por día aunque se corra dos veces)", async ({ M, correr, log }) => {
  M.analisis(1, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "12000000" });
  M.analisis(2, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "2000000" });
  salidaOk(await correr([...ACTIVO, "--flujo", "analisis_riesgo"]));
  const r = await correr([...ACTIVO, "--flujo", "analisis_riesgo"]);
  salidaOk(r);
  assert.match(r.salida, /en espera 1/);
  assert.equal(props(M, R.objeto, 1).hubspot_owner_id, O.monica);
  assert.equal(props(M, R.objeto, 2).hubspot_owner_id ?? null, null);
  assert.equal(props(M, R.objeto, 2).hs_pipeline_stage, R.asignacion);
  assert.equal(log().filter((l) => l.tipo === "en_espera" && l.id === "2").length, 1);
}, { "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: ["miller", "german", "monica", "lorena"].map((persona) => ({ persona, desde: hoy, hasta: hoy })) } });

await escenario("Contratos: tabla, Asesor asociado, arrendador con ejecutivo fijo, clave compartida por carga, sin asesor a directos, reasignaciones con tarea para Ana; reversión", async ({ M, correr, revertir }) => {
  for (const id of [50, 51, 52]) M.contrato(id, { hs_pipeline_stage: C.consolidacion, hubspot_owner_id: O.e_b, contrato_canon: "2000000", contrato_fechaasignacioncontrato: hace(60) });
  M.contrato(53, { hs_pipeline_stage: C.legalizacion, hubspot_owner_id: O.e_c, contrato_canon: "2000000" }); // cerrado: no cuenta
  M.contrato(1, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "100", contrato_canon: "5000000" }, 10, { arrendadores: ["555"] });
  M.contrato(2, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "999", contrato_canon: "4000000" }, 10, { arrendadores: ["111", "CC 5.5.5"], arrendatarios: ["100"] });
  M.contrato(3, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "044476", contrato_canon: "3000000" });
  M.contrato(4, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "200", hubspot_owner_id: O.e_b, contrato_reasignaciones: "1", contrato_canon: "2500000" });
  M.contrato(5, { hs_pipeline_stage: C.asignacion, hubspot_owner_id: O.otro, contrato_canon: "1000000" });
  M.contrato(6, { hs_pipeline_stage: C.asignacion, contrato_canon: "1500000" }, 10, { asesor: 300 });
  M.contrato(7, { hs_pipeline_stage: C.asignacion, contrato_canon: "1200000" }, 10, { arrendatarios: ["555"] }); // 555 es arrendatario, no arrendador
  const r = await correr([...ACTIVO, "--flujo", "contratos"]);
  salidaOk(r);
  assert.equal(props(M, C.objeto, 1).hubspot_owner_id, O.e_a, "clave 100 → e_a (manda sobre el propietario fijo)");
  assert.equal(props(M, C.objeto, 2).hubspot_owner_id, O.e_d, "uno de los arrendadores (CC 5.5.5) tiene ejecutivo fijo → e_d");
  assert.equal(props(M, C.objeto, 3).hubspot_owner_id, O.e_c, "clave compartida: e_b tiene 3 abiertos, e_c ninguno");
  assert.equal(props(M, C.objeto, 4).hubspot_owner_id, O.ana_t, "clave 200 → Ana Tavera");
  assert.ok(DIRECTOS.map(ownerDe).includes(props(M, C.objeto, 5).hubspot_owner_id), "sin asesor → directos");
  assert.equal(props(M, C.objeto, 6).hubspot_owner_id, O.e_e, "clave del Asesor asociado (300) → e_e");
  assert.ok(DIRECTOS.map(ownerDe).includes(props(M, C.objeto, 7).hubspot_owner_id), "un arrendatario no cuenta como propietario");
  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
    const x = props(M, C.objeto, id);
    assert.equal(x.hs_pipeline_stage, C.consolidacion);
    assert.ok(x.contrato_fechaasignacioncontrato, `#${id} sin contrato_fechaasignacioncontrato`);
    assert.equal(x.fecha_asignacion_analista ?? null, null, `#${id} no debe escribir fecha_asignacion_analista`);
  }
  const c4 = props(M, C.objeto, 4);
  assert.equal(c4.contrato_reasignaciones, "2");
  assert.equal(c4.contrato_ejecutivo_anterior, O.e_b);
  assert.ok(c4.contrato_fecha_ultima_reasignacion);
  assert.match(c4.asignacion_detalle, /reasignación: antes lo tenía e_b/);
  const c5 = props(M, C.objeto, 5);
  assert.equal(c5.contrato_reasignaciones, "1", "venir de alguien fuera de la nómina también es reasignación");
  assert.equal(c5.contrato_ejecutivo_anterior, O.otro, "la propiedad es de tipo propietario: se anota cualquier propietario");
  assert.match(c5.asignacion_detalle, /antes lo tenía Otra Persona/);
  assert.equal(props(M, C.objeto, 1).contrato_reasignaciones ?? null, null, "la primera asignación no cuenta");

  assert.deepEqual(M.tareas.map((t) => t.associations[0].to.id).sort(), ["4", "5"], "una tarea por cada contrato reasignado");
  assert.ok(M.tareas.every((t) => t.properties.hubspot_owner_id === O.ana_t));
  const t4 = M.tareas.find((t) => t.associations[0].to.id === "4");
  assert.match(t4.properties.hs_task_subject, /reasignado de e_b a ana_t/);
  assert.match(t4.properties.hs_task_body, /Antes: e_b\. Ahora: ana_t/);

  const v = await revertir(["--aplicar", "--flujo", "contratos"]);
  salidaOk(v);
  const c4b = props(M, C.objeto, 4);
  assert.deepEqual([c4b.hubspot_owner_id, c4b.hs_pipeline_stage, c4b.contrato_reasignaciones, c4b.contrato_ejecutivo_anterior, c4b.contrato_fecha_ultima_reasignacion], [O.e_b, C.asignacion, "1", null, null]);
  assert.deepEqual([props(M, C.objeto, 5).hubspot_owner_id, props(M, C.objeto, 5).contrato_reasignaciones, props(M, C.objeto, 5).contrato_ejecutivo_anterior], [O.otro, null, null]);
  assert.equal(props(M, C.objeto, 1).hubspot_owner_id, null);
});

await escenario("Contratos: ejecutivo de la clave ausente hasta nuevo aviso → reparto solo entre directos (nunca a los demás)", async ({ M, correr, log }) => {
  for (let id = 1; id <= 6; id++) M.contrato(id, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "100" });
  salidaOk(await correr([...ACTIVO, "--flujo", "contratos"]));
  const elegidos = [1, 2, 3, 4, 5, 6].map((id) => props(M, C.objeto, id).hubspot_owner_id);
  assert.ok(elegidos.every((o) => DIRECTOS.map(ownerDe).includes(o)), elegidos.join(","));
  assert.deepEqual(new Set(elegidos).size, 3, "se reparte parejo entre los tres");
  assert.ok(log().filter((l) => l.tipo === "decision").every((l) => /que no está: reparto entre los ejecutivos de directos/.test(l.regla)));
}, { "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: [{ persona: "e_a", desde: "2026-11-16", hasta: null }] } });

await escenario("Contratos: el propietario anterior ya no existe en HubSpot → la reasignación se escribe sin el ejecutivo anterior (no falla) y hay tarea", async ({ M, correr }) => {
  M.contrato(1, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "100", hubspot_owner_id: "777" });
  salidaOk(await correr([...ACTIVO, "--flujo", "contratos"]));
  const x = props(M, C.objeto, 1);
  assert.equal(x.hubspot_owner_id, O.e_a);
  assert.equal(x.contrato_reasignaciones, "1");
  assert.equal(x.contrato_ejecutivo_anterior ?? null, null);
  assert.equal(M.tareas.length, 1);
  assert.match(M.tareas[0].properties.hs_task_subject, /reasignado de el propietario 777 a e_a/);
});

await escenario("Contratos: nadie presente → tarea para Olga y Ana Tavera después de 3 min, una sola vez", async ({ M, correr }) => {
  M.contrato(1, { hs_pipeline_stage: C.asignacion, contrato_orden_claveasesorw: "100" }, 10);
  M.contrato(2, { hs_pipeline_stage: C.asignacion }, 1);
  salidaOk(await correr([...ACTIVO, "--flujo", "contratos"]));
  salidaOk(await correr([...ACTIVO, "--flujo", "contratos"]));
  assert.equal(M.tareas.length, 2);
  assert.deepEqual(M.tareas.map((t) => t.properties.hubspot_owner_id).sort(), [O.ana_t, O.olga].sort());
  assert.ok(M.tareas.every((t) => t.associations[0].to.id === "1"));
  assert.equal(props(M, C.objeto, 1).hs_pipeline_stage, C.asignacion);
}, { "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: ["e_a", "e_b", "e_c", "e_d", "e_e", "ana_t"].map((persona) => ({ persona, desde: hoy, hasta: hoy })) } });

await escenario("Contratos: nadie de directos presente → espera y tarea (no se le da a quien no es de directos)", async ({ M, correr }) => {
  M.contrato(1, { hs_pipeline_stage: C.asignacion }, 10);
  salidaOk(await correr([...ACTIVO, "--flujo", "contratos"]));
  assert.equal(props(M, C.objeto, 1).hubspot_owner_id ?? null, null);
  assert.equal(M.tareas.length, 2);
  assert.match(M.tareas[0].properties.hs_task_body, /no hay ningún ejecutivo de directos presente/);
}, { "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: DIRECTOS.map((persona) => ({ persona, desde: hoy, hasta: hoy })) } });

await escenario("Contratos en sombra, nadie presente: la tarea queda solo en el log", async ({ M, correr, log }) => {
  M.contrato(1, { hs_pipeline_stage: C.asignacion }, 10);
  salidaOk(await correr(["--una-vez", "--flujo", "contratos"]));
  salidaOk(await correr(["--una-vez", "--flujo", "contratos"]));
  assert.equal(M.tareas.length, 0);
  assert.deepEqual(log().filter((l) => l.tipo === "tarea").map((l) => l.escritura), ["sombra", "sombra"]);
}, { "ausencias.json": { diasLaborales: [1, 2, 3, 4, 5], ausencias: ["e_a", "e_b", "e_c", "e_d", "e_e", "ana_t"].map((persona) => ({ persona, desde: hoy, hasta: hoy })) } });

await escenario("Contratos en sombra: no redecide lo decidido, sus decisiones cuentan como carga y la tarea de reasignación queda en el log", async ({ M, correr, log }) => {
  M.contrato(1, { hs_pipeline_stage: C.asignacion });
  M.contrato(2, { hs_pipeline_stage: C.asignacion, hubspot_owner_id: O.e_a });
  salidaOk(await correr(["--una-vez", "--flujo", "contratos"]));
  salidaOk(await correr(["--una-vez", "--flujo", "contratos"]));
  M.contrato(3, { hs_pipeline_stage: C.asignacion });
  salidaOk(await correr(["--una-vez", "--flujo", "contratos"]));
  const decisiones = log().filter((l) => l.tipo === "decision");
  assert.deepEqual(decisiones.map((d) => d.id), ["1", "2", "3"]);
  assert.deepEqual(decisiones.map((d) => d.elegido), ["e_b", "e_c", "e_d"]);
  assert.equal(M.patches(C.objeto).length, 0);
  assert.equal(M.tareas.length, 0);
  assert.deepEqual(log().filter((l) => l.tipo === "tarea_reasignacion").map((l) => [l.id, l.escritura, l.de]), [["2", "sombra", O.e_a]]);
});

await escenario("Reversión de decisiones de antes del motor v2 (Contratos escribía fecha_asignacion_analista)", async ({ M, revertir, escribirLog }) => {
  const t = hace(30);
  M.contrato(9, { hs_pipeline_stage: C.consolidacion, hubspot_owner_id: O.e_a, fecha_asignacion_analista: t, asignacion_detalle: "Motor v1" });
  escribirLog({
    fecha: t, tipo: "decision", flujo: "contratos", modo: "activo", entorno: "sandbox", objeto: C.objeto, id: "9", canon: 1, elegido: "e_a", escritura: "ok",
    anterior: { hubspot_owner_id: null, hs_pipeline_stage: C.asignacion, fecha_asignacion_analista: null, asignacion_detalle: null },
    escrito: { hubspot_owner_id: O.e_a, hs_pipeline_stage: C.consolidacion, fecha_asignacion_analista: t },
  });
  const v = await revertir(["--aplicar"]);
  salidaOk(v);
  const x = props(M, C.objeto, 9);
  assert.deepEqual([x.hubspot_owner_id, x.hs_pipeline_stage, x.fecha_asignacion_analista, x.asignacion_detalle], [null, C.asignacion, null, null]);
});

await escenario("Sin horario ni festivos: con hoy festivo y ningún día laboral asigna igual; --ignorar-horario se sigue aceptando", async ({ M, correr }) => {
  M.analisis(1, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "2000000" });
  M.contrato(1, { hs_pipeline_stage: C.asignacion });
  const r = await correr(ACTIVO);
  salidaOk(r);
  assert.doesNotMatch(r.salida, /ciclo omitido|Sin consultar HubSpot/);
  assert.ok([O.miller, O.german].includes(props(M, R.objeto, 1).hubspot_owner_id), "análisis asignado en festivo");
  assert.ok(DIRECTOS.map(ownerDe).includes(props(M, C.objeto, 1).hubspot_owner_id), "contrato asignado en festivo");
  M.analisis(2, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "2000000" });
  salidaOk(await correr([...ACTIVO, "--ignorar-horario", "--flujo", "analisis_riesgo"]));
  assert.ok([O.miller, O.german].includes(props(M, R.objeto, 2).hubspot_owner_id), "la bandera vieja no rompe nada");
}, { "ausencias.json": { diasLaborales: [], ausencias: [{ persona: "*", desde: hoy, hasta: hoy, motivo: "Festivo de prueba" }] } });

await escenario("Ninguna llamada usa rutas v3 ni v4", async ({ M, correr }) => {
  M.analisis(1, { hs_pipeline_stage: R.asignacion }, { radicacion_canon: "2000000" });
  M.contrato(1, { hs_pipeline_stage: C.asignacion, hubspot_owner_id: O.e_a }, 10, { arrendadores: ["1"], asesor: 7 });
  salidaOk(await correr(ACTIVO));
  assert.ok(M.llamadas.length > 10);
  const malas = M.llamadas.filter((l) => /\/v[34]\//.test(l.ruta)).map((l) => l.ruta);
  assert.deepEqual(malas, []);
});

for (const [estado, nombre, detalle] of resultados) console.log(`${estado === "ok" ? "  ok   " : "  FALLA"} ${nombre}${detalle ? `\n         ${detalle.split("\n").slice(0, 14).join("\n         ")}` : ""}`);
const fallas = resultados.filter((r) => r[0] !== "ok").length;
console.log(fallas ? `\n${fallas} de ${resultados.length} escenarios fallaron.` : `\nLos ${resultados.length} escenarios pasaron.`);
process.exitCode = fallas ? 1 : 0;
