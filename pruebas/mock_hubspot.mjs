// Simulación local de la API 2026-09 de HubSpot que usa asignacion_equilibrada.ts (motor v2). Token esperado: "fake".
import http from "node:http";

const API = "2026-09";
export const R = { objeto: "2-100", pipeline: "935982430", asignacion: "1439946540", tramite: "1439946541", aplazado: "1439946543", aprobado: "1439946542" };
export const C = { objeto: "2-200", pipeline: "953891442", recepcion: "1472969115", asignacion: "1472969116", consolidacion: "1472969117", firmas: "1472969119", legalizacion: "1472969124" };
export const ASESORES = "2-400";
export const PIPE = { solicitud: "935814405", radicacion: "935981686", orden: "949387333" };
export const TIPO = { arrendador: 439, arrendatario: 461, contacto: 435, asesor: 369 };

export const OWNERS = {
  miller: "301", german: "302", monica: "303", lorena: "304",
  e_a: "401", e_b: "402", e_c: "403", e_d: "404", ana_t: "405", olga: "406", e_e: "407", otro: "499",
};
const NOMBRES = {
  301: ["Miller", "Soriano"], 302: ["Germán", "Erazo"], 303: ["María Mónica", "Torralba"], 304: ["Lorena", "Rojas"],
  401: ["Ejecutiva", "Alfa"], 402: ["Ejecutivo", "Beta"], 403: ["Ejecutiva", "Gama"], 404: ["Ejecutivo", "Delta"], 405: ["Ana Leonor", "Tavera Leal"],
  406: ["Olga Janneth", "Sanchez Cortes"], 407: ["Ejecutiva", "Epsilon"], 499: ["Otra", "Persona"],
};

const prop = (name, type = "string", extra = {}) => ({ name, label: name, type, ...extra });
const SISTEMA = [prop("hubspot_owner_id", "enumeration"), prop("hs_pipeline", "enumeration"), prop("hs_pipeline_stage", "enumeration"), prop("hs_object_id", "number"), prop("hs_v2_date_entered_current_stage", "datetime"), prop("asignacion_detalle")];

export async function iniciarMock() {
  const objetos = new Map();
  const nuevo = (id, name, singular, plural, pipelines, propiedades) => {
    const o = { id, name, labels: { singular, plural }, pipelines, propiedades, registros: new Map() };
    objetos.set(id, o);
    return o;
  };
  const etapa = (id, label, displayOrder, cerrada = false) => ({ id, label, displayOrder, metadata: { isClosed: String(cerrada), state: cerrada ? "CLOSED" : "OPEN" } });
  const riesgo = nuevo(R.objeto, "analisis_riesgo", "Análisis de riesgo", "Análisis de riesgo", [
    { id: R.pipeline, label: "Analisis de riesgo", stages: [etapa("1439946538", "Radicado", 0), etapa(R.asignacion, "Asignacion de analista", 2), etapa(R.tramite, "Analista asignado y en tramite", 3), etapa(R.aprobado, "Aprobado", 5, true), etapa(R.aplazado, "Aplazado", 6)] },
  ], [...SISTEMA, prop("analisis_fechaasignacionanalisis", "datetime"), prop("fecha_asignacion_analista", "datetime"), prop("analisis_resultado_motor", "enumeration"), prop("analisis_corredores", "bool")]);
  const contratos = nuevo(C.objeto, "contrato", "Contrato", "Contratos", [
    { id: C.pipeline, label: "Pipeline Contratos", stages: [etapa(C.recepcion, "Recepción", 0), etapa(C.asignacion, "Asignación de ejecutivo", 1), etapa(C.consolidacion, "Consolidación de información", 2), etapa(C.firmas, "Firmas", 4), etapa(C.legalizacion, "Legalización", 9, true)] },
  ], [
    ...SISTEMA, prop("contrato_fechaasignacioncontrato", "datetime"), prop("fecha_asignacion_analista", "datetime"), prop("contrato_canon", "number"),
    prop("contrato_orden_claveasesorw"), prop("contrato_orden_numdocpropw"), prop("contrato_reasignaciones", "number"), prop("contrato_fecha_ultima_reasignacion", "datetime"),
    // Como en el sandbox y en producción: de tipo propietario. La API no lista opciones y acepta cualquier propietario.
    prop("contrato_ejecutivo_anterior", "enumeration", { options: [], referencedObjectType: "OWNER", externalOptions: true }),
  ]);
  nuevo("2-300", "orden_contrato", "Orden de contrato", "Órdenes de contrato", [], SISTEMA);
  const asesores = nuevo(ASESORES, "asesor", "Asesor", "Asesores", [], [prop("asesor_clave", "number"), prop("asesor_nombre")]);
  const deals = nuevo("0-3", "deals", "Negocio", "Negocios", [
    { id: PIPE.solicitud, label: "Solicitudes", stages: [] }, { id: PIPE.radicacion, label: "Radicación", stages: [] }, { id: PIPE.orden, label: "Orden de contrato", stages: [] },
  ], [prop("pipeline", "enumeration"), prop("radicacion_canon", "number"), prop("radicacion_administracion", "number"), prop("valor_canon___admon", "number")]);
  const contactos = nuevo("0-1", "contacts", "Contacto", "Contactos", [], [prop("contacto_id_numero_documento"), prop("documento"), prop("documento_propietario", "number")]);

  // Asociaciones: "<de>|<a>" → (id de origen → [{ id, typeId }]); se guardan en los dos sentidos.
  const asoc = new Map();
  const asociar = (de, idDe, a, idA, typeId = 1) => {
    for (const [x, ix, y, iy] of [[de, idDe, a, idA], [a, idA, de, idDe]]) {
      const k = `${x}|${y}`;
      if (!asoc.has(k)) asoc.set(k, new Map());
      const m = asoc.get(k);
      if (!m.has(String(ix))) m.set(String(ix), []);
      m.get(String(ix)).push({ id: String(iy), typeId });
    }
  };

  const M = {
    riesgo, contratos, deals, contactos, asesores,
    owners: Object.entries(NOMBRES).map(([id, [firstName, lastName]]) => ({ id, firstName, lastName, email: `${id}@ejemplo.co` })),
    tareas: [],
    llamadas: [],
  };
  const evaluar = (r, f) => {
    const v = r.properties[f.propertyName];
    const vacio = v === undefined || v === null || v === "";
    switch (f.operator) {
      case "EQ": return !vacio && String(v) === String(f.value);
      case "IN": return !vacio && f.values.map(String).includes(String(v));
      case "NOT_HAS_PROPERTY": return vacio;
      case "HAS_PROPERTY": return !vacio;
      case "GTE": { if (vacio) return false; const a = /^\d+$/.test(v) ? Number(v) : Date.parse(v); return a >= Number(f.value); }
      default: throw new Error(`operador no soportado en el mock: ${f.operator}`);
    }
  };
  const pick = (r, props) => ({ id: r.id, properties: Object.fromEntries([...props.map((p) => [p, r.properties[p] ?? null]), ["hs_object_id", r.id]]) });

  const servidor = http.createServer((req, res) => {
    let texto = "";
    req.on("data", (c) => (texto += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const ruta = url.pathname;
      const cuerpo = texto ? JSON.parse(texto) : null;
      M.llamadas.push({ metodo: req.method, ruta, cuerpo });
      const responder = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer fake") return responder(401, { message: "token inválido" });
      if (ruta.includes("/v3/") || ruta.includes("/v4/")) return responder(404, { message: `ruta v3/v4 no permitida: ${ruta}` });

      if (req.method === "GET" && ruta === `/crm-object-schemas/${API}/schemas`) return responder(200, { results: [...objetos.values()].filter((o) => o.id.startsWith("2-")).map((o) => ({ objectTypeId: o.id, name: o.name, labels: o.labels })) });
      if (req.method === "GET" && ruta === `/crm/owners/${API}`) return responder(200, { results: M.owners });
      let m = ruta.match(new RegExp(`^/crm/pipelines/${API}/([^/]+)$`));
      if (m && objetos.has(m[1])) return responder(200, { results: objetos.get(m[1]).pipelines });
      m = ruta.match(new RegExp(`^/crm/properties/${API}/([^/]+)$`));
      if (m && objetos.has(m[1])) return responder(200, { results: objetos.get(m[1]).propiedades });
      m = ruta.match(new RegExp(`^/crm/associations/${API}/tasks/([^/]+)/labels$`));
      if (m) return responder(200, { results: [{ category: "USER_DEFINED", typeId: 130, label: null }] });
      m = ruta.match(new RegExp(`^/crm/associations/${API}/${C.objeto}/0-1/labels$`));
      if (m) return responder(200, { results: [{ category: "USER_DEFINED", typeId: TIPO.contacto, label: null }, { category: "USER_DEFINED", typeId: TIPO.arrendador, label: "Arrendador Cto" }, { category: "USER_DEFINED", typeId: TIPO.arrendatario, label: "Arrendatario Cto" }] });
      m = ruta.match(new RegExp(`^/crm/associations/${API}/([^/]+)/([^/]+)/batch/read$`));
      if (m && req.method === "POST") {
        const mapa = asoc.get(`${m[1]}|${m[2]}`) ?? new Map();
        const results = cuerpo.inputs.filter((x) => mapa.has(String(x.id))).map((x) => ({
          from: { id: String(x.id) },
          to: mapa.get(String(x.id)).map((t) => ({ toObjectId: Number(t.id), associationTypes: [{ category: "USER_DEFINED", typeId: t.typeId, label: null }] })),
        }));
        return responder(results.length === cuerpo.inputs.length ? 200 : 207, { results, errors: [] });
      }
      if (req.method === "POST" && ruta === `/crm/objects/${API}/tasks`) {
        const p = cuerpo.properties ?? {};
        if (!p.hs_timestamp) return responder(400, { message: "falta hs_timestamp" });
        if (!M.owners.some((o) => o.id === p.hubspot_owner_id)) return responder(400, { message: "propietario inválido" });
        const a = cuerpo.associations?.[0];
        if (!a?.to?.id || a.types?.[0]?.associationTypeId !== 130) return responder(400, { message: "asociación inválida" });
        M.tareas.push(cuerpo);
        return responder(201, { id: String(9000 + M.tareas.length) });
      }
      m = ruta.match(new RegExp(`^/crm/objects/${API}/([^/]+)/batch/read$`));
      if (m && objetos.has(m[1]) && req.method === "POST") {
        const o = objetos.get(m[1]);
        return responder(200, { results: cuerpo.inputs.filter((x) => o.registros.has(String(x.id))).map((x) => pick(o.registros.get(String(x.id)), cuerpo.properties ?? [])) });
      }
      m = ruta.match(new RegExp(`^/crm/objects/${API}/([^/]+)/search$`));
      if (m && objetos.has(m[1]) && req.method === "POST") {
        const o = objetos.get(m[1]);
        const desc = cuerpo.sorts?.[0]?.direction === "DESCENDING";
        const lista = [...o.registros.values()].filter((r) => (cuerpo.filterGroups ?? [{ filters: [] }]).some((g) => g.filters.every((f) => evaluar(r, f)))).sort((a, b) => (desc ? -1 : 1) * (Number(a.id) - Number(b.id)));
        const desde = Number(cuerpo.after ?? 0);
        const limite = cuerpo.limit ?? 10;
        return responder(200, {
          total: lista.length,
          results: lista.slice(desde, desde + limite).map((r) => pick(r, cuerpo.properties ?? [])),
          ...(desde + limite < lista.length ? { paging: { next: { after: String(desde + limite) } } } : {}),
        });
      }
      m = ruta.match(new RegExp(`^/crm/objects/${API}/([^/]+)/(\\d+)$`));
      if (m && objetos.has(m[1])) {
        const o = objetos.get(m[1]);
        const r = o.registros.get(m[2]);
        if (!r) return responder(404, { message: "no existe" });
        if (req.method === "GET") return responder(200, pick(r, (url.searchParams.get("properties") ?? "").split(",").filter(Boolean)));
        if (req.method === "PATCH") {
          const etapas = o.pipelines.flatMap((p) => p.stages.map((s) => s.id));
          for (const [k, v] of Object.entries(cuerpo.properties ?? {})) {
            const def = o.propiedades.find((p) => p.name === k);
            if (!def) return responder(400, { message: `la propiedad ${k} no existe` });
            if (k === "hs_pipeline_stage" && !etapas.includes(v)) return responder(400, { message: `etapa inválida ${v}` });
            const dePropietario = k === "hubspot_owner_id" || def.referencedObjectType === "OWNER";
            if (dePropietario && v !== "" && !M.owners.some((x) => x.id === v)) return responder(400, { message: `propietario inválido ${v} en ${k}` });
            if (!dePropietario && def.options && v !== "" && !def.options.some((x) => x.value === v)) return responder(400, { message: `${v} no es una opción de ${k}` });
            if (def.type === "datetime" && v !== "" && Number.isNaN(Date.parse(v))) return responder(400, { message: `fecha inválida ${v}` });
          }
          for (const [k, v] of Object.entries(cuerpo.properties ?? {})) {
            r.properties[k] = v === "" ? null : v;
            if (k === "hs_pipeline_stage") r.properties.hs_v2_date_entered_current_stage = new Date().toISOString();
          }
          return responder(200, pick(r, Object.keys(r.properties)));
        }
      }
      return responder(404, { message: `el mock no conoce ${req.method} ${ruta}` });
    });
  });
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  M.url = `http://127.0.0.1:${servidor.address().port}`;
  M.cerrar = () => new Promise((ok) => servidor.close(ok));
  M.patches = (objeto) => M.llamadas.filter((l) => l.metodo === "PATCH" && l.ruta.includes(`/${objeto}/`));

  const hace = (min) => new Date(Date.now() - min * 60_000).toISOString();
  /**
   * Un análisis. `radicacion`: las propiedades de la Radicación. Como en producción, por defecto el análisis queda
   * asociado a una Solicitud (sin canon) y la Radicación cuelga de esa Solicitud; con directo: true, a la Radicación.
   */
  M.analisis = (id, props, radicacion = null, { directo = false, solicitud = {} } = {}) => {
    riesgo.registros.set(String(id), { id: String(id), properties: { hs_pipeline: R.pipeline, hs_v2_date_entered_current_stage: hace(10), ...props } });
    if (!radicacion) return;
    const radId = String(70000 + Number(id));
    deals.registros.set(radId, { id: radId, properties: { pipeline: PIPE.radicacion, ...radicacion } });
    if (directo) return asociar(R.objeto, id, "0-3", radId, 201);
    const solId = String(60000 + Number(id));
    deals.registros.set(solId, { id: solId, properties: { pipeline: PIPE.solicitud, ...solicitud } });
    asociar(R.objeto, id, "0-3", solId, 201);
    asociar("0-3", solId, "0-3", radId, 24);
    const ordenId = String(80000 + Number(id)); // la orden de contrato también cuelga de la Solicitud y no tiene canon
    deals.registros.set(ordenId, { id: ordenId, properties: { pipeline: PIPE.orden } });
    asociar("0-3", solId, "0-3", ordenId, 373);
  };
  /** Un contrato; `arrendadores`: documentos de sus contactos "Arrendador Cto"; `asesor`: clave del Asesor asociado. */
  M.contrato = (id, props, minutos = 10, { arrendadores = [], arrendatarios = [], asesor = null } = {}) => {
    contratos.registros.set(String(id), { id: String(id), properties: { hs_pipeline: C.pipeline, hs_v2_date_entered_current_stage: hace(minutos), ...props } });
    let n = 0;
    for (const [lista, tipo] of [[arrendadores, TIPO.arrendador], [arrendatarios, TIPO.arrendatario]]) {
      for (const doc of lista) {
        const cid = String(50000 + Number(id) * 10 + n++);
        contactos.registros.set(cid, { id: cid, properties: { contacto_id_numero_documento: doc } });
        asociar(C.objeto, id, "0-1", cid, tipo);
      }
    }
    if (asesor !== null) {
      const aid = String(40000 + Number(id));
      asesores.registros.set(aid, { id: aid, properties: { asesor_clave: String(asesor) } });
      asociar(C.objeto, id, ASESORES, aid, TIPO.asesor);
    }
  };
  return M;
}
