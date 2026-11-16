# Asignación equilibrada (Análisis de riesgo y Contratos)

Documento del 16 de noviembre de 2026 (motor v2, con las reglas de negocio de ese día y las correcciones de la revisión de Duvan del mismo día). Describe lo que hay en este repositorio tal como está hoy.

## Para la IA que lea esto

Este documento está escrito para otra IA (o un ingeniero) que tiene que **analizar este repositorio y ubicarlo dentro de un monorepo Turborepo**. Lo que se espera de ti:

1. Entender qué hace el paquete y qué necesita para correr (secciones 1 a 4).
2. Decidir dónde va en el monorepo y cómo se conecta con `turbo.json` (sección 6, que es una propuesta).
3. Respetar las restricciones de la sección 5: el código no se compila y sus rutas dependen de dónde esté el archivo.
4. No ejecutar nada que escriba en HubSpot. Lo que sí puedes correr con seguridad es `npm test`, `npm run e2e` (usa un HubSpot simulado en localhost) y `npm run typecheck`.

**Los hechos de este documento se verificaron el 16 de noviembre de 2026.** Si algo que ves en el código lo contradice, manda el código.

---

## 1. Qué es

Un script de Node que reparte los registros que esperan responsable en HubSpot. Trabaja en dos flujos, cada uno con su equipo, sus reglas y su forma de medir la carga:

| Flujo (`--flujo`) | Objeto de HubSpot | Etapas de origen → destino | Condición |
|---|---|---|---|
| `analisis_riesgo` | Análisis de riesgo | *Asignacion de analista* y *Aplazado* → *Analista asignado y en tramite* | Solo registros **sin** propietario. De *Aplazado*, solo los que tienen *Resultado del motor* = Aplazado |
| `contratos` | Contratos | *Asignación de ejecutivo* → *Consolidación de información* | Con o sin propietario: el que traiga se **reemplaza** |

Las pipelines y las etapas tienen los mismos IDs en el sandbox y en producción. Están fijas en `FLUJOS`, en el código. Los objetos sí cambian de ID entre los dos entornos, y el script los encuentra por nombre.

**Cómo decide.** Primero aplica las reglas de negocio del flujo, que están en `data/<flujo>/reglas.json`. Lo que ninguna regla decide se reparte con una regla *greedy* de costo marginal que pesa los casos y el monto.
- **Análisis de riesgo.**
  - Va directo a una coordinadora (Mónica), sin pasar por el reparto y **aunque esté ausente**: lo de más de 10 millones de canon + administración y lo marcado como negocio de corredores (`analisis_corredores`).
  - El canon y la administración salen de la **Radicación** (negocio de la pipeline `935981686`). El Análisis está asociado a la Solicitud (pipeline `935814405`), que no los trae, así que el script pasa de la Solicitud a la Radicación asociada a ella.
  - El resto se reparte entre los analistas del reparto (hoy Miller y Germán), sin techo.
  - La carga de cada analista es lo asignado en los últimos 30 días hábiles, con olvido diario, según la fecha oficial `analisis_fechaasignacionanalisis`.
- **Contratos.** El ejecutivo sale, en este orden, de:
  1. La tabla de Ana: clave del asesor → ejecutivo (incluye las claves de Ana Tavera, que van a ella). La clave es `contrato_orden_claveasesorw` o, si el contrato no la trae, la del Asesor asociado.
  2. La lista de propietarios con ejecutivo fijo: basta con que uno de los contactos asociados con la etiqueta «Arrendador Cto» tenga su cédula en la lista.
  3. Las claves compartidas: reparto solo entre sus ejecutivos.
  4. Sin asesor o con una clave fuera de la tabla: reparto entre los **cinco ejecutivos de directos** (`directos` en `reglas.json`).

  Si el ejecutivo que corresponde no está (o ninguno de la clave compartida), el reparto es entre los de directos presentes. Si tampoco hay ninguno, el contrato espera y a los 3 minutos hay tarea para Olga y Ana Tavera. Si el contrato traía otro propietario, se reemplaza, se anotan el ejecutivo anterior, el número de reasignaciones y su fecha, y se crea una tarea para Ana Tavera con el anterior y el nuevo.

  La carga de cada ejecutivo son los contratos que tiene abiertos en ese momento. En empate gana quien lleva más tiempo sin recibir.

Al final deja a la persona como propietaria y el registro en la etapa de destino. El script no guarda estado propio entre ciclos: todo sale de HubSpot y del log.

**Qué NO hace.** No tiene servidor ni endpoint: nada lo llama por red. Un disparador externo (n8n) ejecuta el comando y el script hace un ciclo y termina.

## 2. Datos clave para empaquetarlo

| | |
|---|---|
| Lenguaje | TypeScript, ejecutado **directamente por Node** (*type stripping*). Sin compilar y sin empaquetar. |
| Runtime | **Node 24 o superior.** Usa `import.meta.main`, `import.meta.dirname` y `process.loadEnvFile`. En una versión anterior no arranca: `import.meta.main` no existe y el script termina sin hacer nada ni imprimir nada. |
| Dependencias de ejecución | **Ninguna.** Solo módulos `node:` (también lee `.xlsx` sin librerías). |
| Dependencias de desarrollo | `typescript` `^7.0.2` y `@types/node` `^24.19.2` |
| Módulos | ESM (`"type": "module"`) |
| Gestor | npm (hay `package-lock.json`) |
| Scripts de `package.json` | `test` → `node asignacion_equilibrada.ts --autoprueba` · `typecheck` → `tsc` · `e2e` → `node pruebas/e2e.mjs` |
| Estado de las pruebas | `npm test`: 47 pruebas, todas pasan. `npm run e2e`: 14 escenarios de punta a punta, todos pasan. `npm run typecheck`: sin errores. (16 de noviembre) |
| Tamaño | `asignacion_equilibrada.ts` unas 3.000 líneas, `revertir_asignacion.ts` 370 líneas |
| Defectos de `package.json` | `"main": "index.js"` apunta a un archivo que no existe, `description` vacía y no declara `engines` |

## 3. Estructura del repositorio

```
asignacion_equilibrada.ts     El motor, las reglas, el cliente de HubSpot, el diagnóstico y la CLI (un solo archivo)
revertir_asignacion.ts        Deshace asignaciones de prueba; importa de asignacion_equilibrada.ts
package.json, tsconfig.json   Configuración
n8n/                          Los dos workflows de n8n que disparan el script (sección 4.3)
pruebas/                      Prueba de punta a punta: un HubSpot simulado (API 2026-09) y 14 escenarios
data/                         Datos de negocio que el script lee en cada ciclo (ver más abajo)
logs/                         Lo genera el script: decisiones, candado y reversiones (ignorada por git)
.env                          Tokens de HubSpot (ignorado por git; nunca se sube)
hallazgos_hubspot_mongo.html  NO pertenece a este paquete (ver sección 7)
```

**`data/`**

| Archivo | Para qué | ¿Va a git? |
|---|---|---|
| `data/<flujo>/nomina.json` | Persona ↔ documento (cédula) ↔ propietario de HubSpot ↔ rol ↔ activo ↔ si entra al reparto | **No: tiene cédulas reales** |
| `data/<flujo>/parametros.json` | Monto típico, pesos por rol y techos; lo genera `--parametros` | Sí |
| `data/<flujo>/reglas.json` | Reglas de negocio. En Análisis, lo que va directo y a quién. En Contratos, las claves compartidas, los ejecutivos de directos y las dos tareas (por no asignar a tiempo y por reasignación) | Sí |
| `data/contratos/asesores.json` | Clave del asesor → ejecutivo. Lo genera `--importar-asesores` desde el Excel de Ana; **todavía no existe** | Sí |
| `data/contratos/propietarios.json` | Cédula del propietario → ejecutivo fijo, de la lista del correo de Ana. **Hoy está vacío** | **No: tiene cédulas** |
| `data/ausencias.json` | Días laborales, festivos (hasta el 31-dic-2027) y ausencias de cada persona (`"hasta": null` es hasta nuevo aviso) | Sí |
| `data/PAUSA`, `data/<flujo>/PAUSA` | Interruptores de apagado, global o por flujo. Si el archivo existe, no se asigna nada | No |

**Organización del código.** `asignacion_equilibrada.ts` está dividido en secciones numeradas:
1. Constantes
2. Tipos y flujos
3. Utilidades
4. Motor (funciones puras)
5. Reglas de negocio (funciones puras)
6. Datos locales (nómina, parámetros, ausencias, reglas y lector de `.xlsx`/`.csv`)
7. Cliente de HubSpot
8. Diagnóstico
9. Ciclo de asignación
10. Candado y arranque
11. Parámetros desde AGSSA
12. Autoprueba
13. Punto de entrada

Casi todo se exporta para las pruebas, pero **solo `revertir_asignacion.ts` importa del archivo** (`./asignacion_equilibrada.ts`, con la extensión `.ts`).

## 4. Cómo se usa

### 4.1 Comandos

```
node asignacion_equilibrada.ts                  ciclo continuo cada 2 min, en MODO SOMBRA
node asignacion_equilibrada.ts --activar        igual, pero escribe en HubSpot
node asignacion_equilibrada.ts --una-vez        un solo ciclo y termina (lo usa n8n)
node asignacion_equilibrada.ts --diagnostico    revisa token, scopes, objetos, etapas, propiedades, reglas y propietarios
node asignacion_equilibrada.ts --parametros     recalcula data/<flujo>/parametros.json desde AGSSA
node asignacion_equilibrada.ts --importar-asesores <archivo.xlsx|.csv>
                                                convierte el Excel de Ana en data/contratos/asesores.json
node asignacion_equilibrada.ts --autoprueba     pruebas del motor y de las reglas
node revertir_asignacion.ts [--aplicar]         deshace asignaciones de prueba
```

Opciones comunes:
- `--flujo analisis_riesgo|contratos`: solo ese flujo. Se puede repetir; por defecto corre los dos.
- `--produccion`: usa `HUBSPOT_TOKEN` en vez de `HUBSPOT_TOKEN_SANDBOX`.
- `--ignorar-horario`: ejecuta fuera de 7:30 a 4:30 y en días no laborales, incluidos los festivos de `data/ausencias.json` (pruebas). Las ausencias de cada persona se siguen respetando.

**Seguro por defecto.** Sin `--activar` corre en **modo sombra**: decide exactamente como si escribiera, pero solo anota en `logs/decisiones.jsonl`. Escribe en HubSpot solo con `--activar`. El entorno por defecto es el sandbox.

### 4.2 Códigos de salida

| Código | Cuándo |
|---|---|
| `0` | Ciclo correcto, aunque algún registro quede esperando. O ciclo omitido sin tocar HubSpot: fuera de horario, día no laboral, interruptor `PAUSA`, o ya hay otra ejecución de menos de 10 min |
| `1` | Falló un ciclo o hubo un error fatal de HubSpot |
| `2` | Error de uso o de configuración; o el candado lleva 10 min o más ocupado |

### 4.3 Disparo con n8n

n8n es solo el timbre; el script hace todo lo demás.

1. Un Schedule Trigger corre cada 30 s, de lunes a viernes, de 7:30 a 4:30, en la zona horaria `America/Bogota`.
2. El nodo **Configuración** (Code) tiene lo único que se cambia a mano:
   - `ENTORNO`: `sandbox` o `produccion`.
   - `ACTIVAR`: modo sombra o escribir.
   - `IGNORAR_HORARIO`.

   Con eso arma los IDs de los objetos y las consultas de las dos colas, con los mismos filtros que `filtrosCola` del script.
3. Dos HTTP Request consultan HubSpot (`/crm/objects/2026-09/{objeto}/search`) con `limit: 1` y leen solo `total`.
4. Si alguna cola tiene registros, ejecuta `node asignacion_equilibrada.ts --una-vez [--produccion] [--activar] [--ignorar-horario] --flujo ...`.
5. Si el código de salida no es 0, marca la ejecución como error.

Archivos:
- `n8n/disparador_algoritmo_asignacion.json`: **para el servidor**, con el nodo SSH. Es el que va a producción.
- `n8n/disparador_algoritmo_asignacion_local.json`: **para pruebas en un PC**, con el nodo Execute Command. Tiene la ruta absoluta de este PC en el comando.

Ninguno trae credenciales: hay que elegirlas al importarlos, y la credencial de las colas tiene que ser del mismo entorno que `ENTORNO`.

### 4.4 Configuración

El script lee `.env` junto a sí mismo y las variables del proceso tienen prioridad sobre ese archivo.

| Variable | Para qué |
|---|---|
| `HUBSPOT_TOKEN_SANDBOX` | Token del sandbox (obligatoria sin `--produccion`) |
| `HUBSPOT_TOKEN` | Token de producción (obligatoria con `--produccion`) |
| `HUBSPOT_<FLUJO>_OBJETO` | Opcional: fija el objeto que el diagnóstico descubre por nombre. `<FLUJO>` es `ANALISIS_RIESGO` o `CONTRATOS` |
| `HUBSPOT_API_URL` | Solo para pruebas. Acepta `https://api.hubapi.com` o `http://localhost:<puerto>`; cualquier otra cosa la rechaza |
| `AGSSA_SERVIDOR`, `AGSSA_BASE` | Solo para `--parametros`. Por defecto `.\SQLEXPRESS` y `AGSSA_PROD` |

Los tokens son secretos: no se imprimen ni se suben. Las variables `_PIPELINE`, `_ETAPA_COLA`, `_ETAPA_DESTINO` y `_PROP_CANON` de la versión anterior ya no existen: las etapas están en `FLUJOS` y el monto lo define cada flujo.

### 4.5 Integraciones externas

- **HubSpot** (`https://api.hubapi.com`). Usa las rutas de la versión **2026-09** de la API: `/crm/objects/2026-09/...`, `/crm/pipelines/2026-09/...`, `/crm/properties/2026-09/...`, `/crm/owners/2026-09`, `/crm-object-schemas/2026-09/schemas` y `/crm/associations/2026-09/...`. La v3 se apaga en septiembre de 2027.
  - **Scopes de la app privada:** `crm.objects.custom.read`, `crm.objects.custom.write`, `crm.schemas.custom.read`, `crm.objects.owners.read`, `crm.objects.deals.read` (el monto de Análisis está en la Radicación), `crm.objects.contacts.read` y `crm.schemas.contacts.read` (las cédulas de los arrendadores). Además, el permiso de crear tareas.
  - **Propiedades en Análisis de riesgo:** `analisis_fechaasignacionanalisis` (la fecha oficial) y `asignacion_detalle`. Hasta el 16 de noviembre el script escribía `fecha_asignacion_analista`; la reversión todavía la conoce.
  - **Propiedades en Contratos:** `contrato_fechaasignacioncontrato`, `asignacion_detalle`, `contrato_ejecutivo_anterior`, `contrato_reasignaciones` y `contrato_fecha_ultima_reasignacion`. Lee además el Asesor asociado (`asesor_clave`) y los contactos «Arrendador Cto» (`contacto_id_numero_documento`, `documento` o `documento_propietario`). La etiqueta se busca por nombre: su tipo de asociación es 226 en el sandbox y 439 en producción.
  - **Reasignaciones (DH-28):** el 16 de noviembre ningún contrato de producción tenía llenas las tres propiedades de reasignación, así que ningún workflow las está escribiendo y el script lleva la cuenta. Si se activa un workflow que también las incremente, contaría doble.
- **AGSSA** (SQL Server): **solo lo usa `--parametros`**, a través del ejecutable `sqlcmd` con autenticación de Windows (`-E`). Necesita Windows, `sqlcmd` en el PATH y acceso de red a esa base. El flujo normal no depende de AGSSA.

### 4.6 Garantías de seguridad del script

- **Una sola instancia a la vez**, con un candado en `logs/asignacion.lock`.
- **Relee el registro** antes de escribir, y lo salta si ya no está en la cola.
- **Reintenta** ante 429, errores 5xx y fallas de red.
- **Tope de 200 registros por cola** en modo activo.
- **Reversible en pruebas:** antes de escribir guarda en el log lo que el registro tenía, y `revertir_asignacion.ts` lo devuelve a ese estado. Funciona también con las decisiones anteriores al motor v2.
- **Qué escribe:**
  - En todos los flujos: propietario, etapa, su fecha de asignación y `asignacion_detalle`.
  - En una reasignación de Contratos, además: el ejecutivo anterior (si es una de las opciones de esa propiedad), el número de reasignaciones y su fecha, y una tarea para Ana Tavera con el anterior y el nuevo.
  - Una tarea para coordinación cuando un contrato lleva más de 3 minutos sin poderse asignar.
  - La reversión no borra las tareas: esas se cierran a mano.
- **Lo que no puede asignar lo deja en la cola** y lo anota: una línea `en_espera` por registro y por día, o la tarea de Contratos.

## 5. Restricciones que el monorepo tiene que respetar

1. **No transpilar ni empaquetar.** Node ejecuta los `.ts` tal cual. El `tsconfig.json` tiene `noEmit`, `allowImportingTsExtensions` y `erasableSyntaxOnly`: el código no usa sintaxis de TypeScript que genere JavaScript (enums, parameter properties, namespaces). Si se extiende una configuración base, esas tres opciones tienen que seguir activas.
2. **Las rutas dependen del archivo, no de dónde se corra.** `.env`, `data/` y `logs/` se buscan con `import.meta.dirname`, es decir, **junto a `asignacion_equilibrada.ts`**. Si el archivo cambia de carpeta, esos tres tienen que moverse con él. El `.env` de la raíz del monorepo **no** se lee.
3. **Los imports llevan la extensión `.ts`.** No usar alias de rutas, `paths` ni extensiones `.js`.
4. **Nada de acciones con efectos en tareas cacheables.** `npm test` es puro: no toca HubSpot, AGSSA ni `data/`. `npm run e2e` tampoco toca HubSpot ni `data/`, pero escribe sus corridas en `logs/e2e/`. Todo lo demás consulta HubSpot o escribe en `logs/` (y `--importar-asesores` escribe en `data/`).
5. **Node 24.** El entorno donde corra (servidor, CI, contenedor) tiene que tener Node 24 o superior.
6. **`--parametros` no corre en Linux.** Necesita Windows, `sqlcmd` y acceso a AGSSA. Se corre en un PC que tenga ese acceso y se copia el `parametros.json` resultante.
7. **Los archivos de `data/` que no van a git** (nóminas y propietarios) se copian a mano al servidor.

## 6. Propuesta para Turborepo (no aplicada todavía)

**Ubicación:** `apps/asignacion-equilibrada/`. Es un ejecutable que se despliega y no una librería: nada de lo demás lo importa. Todo el contenido de este repo entra en esa carpeta, **sin separar archivos**, para no romper las rutas de la sección 5.

**`package.json` del paquete:** conservar los dos scripts actuales y agregar:

```json
{
  "name": "@<org>/asignacion-equilibrada",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node asignacion_equilibrada.ts --autoprueba",
    "typecheck": "tsc",
    "diagnostico": "node asignacion_equilibrada.ts --diagnostico",
    "una-vez": "node asignacion_equilibrada.ts --una-vez",
    "revertir": "node revertir_asignacion.ts"
  }
}
```

Quitar `"main": "index.js"`, que no existe. `<org>` es el scope del monorepo, que este repo no define.

**`turbo.json`** (sintaxis de Turborepo 2):

```json
{
  "tasks": {
    "typecheck": { "inputs": ["*.ts", "tsconfig.json", "package.json"], "outputs": [] },
    "test": { "inputs": ["*.ts", "package.json"], "outputs": [] },
    "diagnostico": { "cache": false, "passThroughEnv": ["HUBSPOT_*", "AGSSA_*"] },
    "una-vez": { "cache": false, "passThroughEnv": ["HUBSPOT_*", "AGSSA_*"] },
    "revertir": { "cache": false, "passThroughEnv": ["HUBSPOT_*", "AGSSA_*"] }
  }
}
```

- **No hay tarea `build`:** no hay nada que compilar.
- **`passThroughEnv` y no `env`:** así los tokens llegan al proceso sin entrar en el hash de la caché. Hay que comprobar que la versión de Turborepo del monorepo acepte comodines como `HUBSPOT_*`; si no, se listan las variables una por una.
- **Con el `.env` en la carpeta del paquete no hace falta `passThroughEnv`:** el script lo lee él mismo. Solo sirve para variables que se definan fuera, por ejemplo en CI.
- **`typecheck`, `test` y `e2e` son las únicas tareas para CI** (`e2e` levanta un HubSpot simulado en localhost y escribe en `logs/e2e/`). `una-vez`, `diagnostico` y `revertir` hablan con HubSpot de verdad: no deben correr automáticamente en CI.

**Qué más revisar al ubicarlo:**
- **El despliegue es aparte del monorepo.** En producción, n8n llega al script por SSH en un servidor con Node 24. Al servidor se copia el contenido de `apps/asignacion-equilibrada/`, sin `node_modules/` ni `logs/`. Además se copian el `.env` y los archivos de `data/` que no van a git.
- **Comentarios con rutas de otra época.** La cabecera de `asignacion_equilibrada.ts` apunta a `C:\Temp\Plan_Asignacion_Equilibrada_Analisis_Riesgo.md` y al anexo `..._detalle.md`. Esos documentos no están en el repo (ver sección 7).

## 7. Pendientes

**Técnicos, antes de subir a git:**
1. **`hallazgos_hubspot_mongo.html` no pertenece a este paquete.** Es un informe sobre la extracción de HubSpot y su empalme con Mongo (`agssa_prod`). Conviene moverlo a donde corresponda en el monorepo.
2. **Los documentos de diseño están fuera del repo, en `C:\Temp`:**
   - `Plan_Asignacion_Equilibrada_Analisis_Riesgo.md`: resumen del plan.
   - `Plan_Asignacion_Equilibrada_Analisis_Riesgo_detalle.md`: el diseño completo, los datos, las simulaciones y las decisiones.
   - `Guia_n8n_Asignacion_Equilibrada.md`: la guía paso a paso de n8n.

   El documento de reglas del 16 de noviembre ("Reglas de asignación — Análisis de riesgo y Contratos") tampoco está. Conviene copiarlos todos a `docs/` dentro del paquete.
3. **Los parámetros están viejos.** La copia de AGSSA llega al 2 de julio de 2026. `analisis_riesgo` se recalibró el 16 de noviembre con abril a julio (canon + administración, solo Miller y Germán) y `contratos` es de abril a julio. Como ningún flujo usa techo, solo pesa el monto típico. El script avisa a partir de 100 días.
4. **El token de producción del `.env` no es el de escritura.** El 16 de noviembre `HUBSPOT_TOKEN` leía negocios pero daba 403 en los objetos personalizados. Duvan entrega el token de la app privada `62186116`; va en `.env` como `HUBSPOT_TOKEN` y después `--diagnostico --produccion` tiene que terminar en «Todo listo».

**Datos que faltan (los entrega Ana Tavera):**
- Importar el Excel de Ana (`EJECUTIVOS Y ASESORES NOVIEMBRE 2026.xlsx`, 1.691 claves) con `--importar-asesores`. Mientras no esté, solo deciden las claves compartidas y lo demás va a los ejecutivos de directos.
- Copiar a `data/contratos/propietarios.json` los 10 propietarios con ejecutivo fijo del correo de Ana del 8 y 9 de noviembre (8 a Laura Daniela Castro y 2 a Luz Andrea Castellanos).

**Decisiones de negocio cerradas el 16 de noviembre** (ya están en el código y en `data/`): la clave fuera del Excel y el contrato sin asesor van a los cinco de directos; las 35 claves de Ana Tavera van a ella; Francisco Rocha y Andrés Amaya están ausentes hasta nuevo aviso; a Mónica solo va lo de más de 10 millones y lo de corredores, aunque esté ausente. El workflow «Asignación Analista» solo existe en el sandbox: en producción no hay otro workflow que asigne Análisis ni Contratos.
