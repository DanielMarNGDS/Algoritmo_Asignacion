# Despliegue en Kubernetes

Instrucciones para correr la asignación equilibrada (Análisis de riesgo y Contratos) en un clúster de Kubernetes, en
lugar del workflow de n8n. Verificadas el 19 de noviembre de 2026 contra producción, sin escribir nada.

## Cómo corre

El script corre **un ciclo cada 30 segundos**, todos los días y a cualquier hora:

```
node asignacion_equilibrada.ts --una-vez --produccion --activar
```

- **Cómo se logran los 30 segundos.** Un CronJob no se puede programar por segundos: lo mínimo es un minuto. Por eso el CronJob lanza un pod por minuto y ese pod hace **dos ciclos**, uno al arrancar y otro a los 30 segundos. Los argumentos van en la variable `ARGUMENTOS` del contenedor.
- **Qué hace cada ciclo.** Lee las colas de HubSpot. Si hay registros, los asigna y los mueve de etapa. Si no hay nada, termina en uno o dos segundos.
- **Sin horario ni festivos.** Desde el 19 de noviembre asigna de noche, los fines de semana y los festivos. `data/ausencias.json` solo saca a las personas ausentes; los festivos ya no detienen nada.
- **Nunca dos a la vez:** `concurrencyPolicy: Forbid` (no arranca un pod mientras el anterior sigue), los dos ciclos de cada pod van uno detrás del otro, y además hay un candado en el volumen de logs. Si un ciclo tarda más de 30 segundos, el siguiente arranca apenas termine.
- **No guarda estado propio entre ciclos.** Todo sale de HubSpot y del log de decisiones, que vive en un volumen persistente.
- **Reemplaza a n8n.** Con el CronJob no hace falta n8n. **Solo puede haber un disparador en producción**: o n8n o el CronJob (ver «Corte desde n8n»).

| Pieza | Archivo o recurso | Qué tiene |
|---|---|---|
| Imagen | `Dockerfile` (raíz del repo) | `node:24-alpine`, los dos scripts, `package.json` y `data/` sin nóminas ni propietarios |
| CronJob | `deploy/kubernetes/cronjob.yaml` | Un pod por minuto con dos ciclos (cada 30 s) y los montajes |
| Volumen | `deploy/kubernetes/pvc.yaml` | `logs/`: decisiones, reversiones y candado (1 Gi) |
| Secret `asignacion-hubspot` | Se crea con `kubectl` | `HUBSPOT_TOKEN` (token de escritura de producción) |
| Secret `asignacion-datos` | Se crea con `kubectl` | Las dos nóminas y los propietarios con ejecutivo fijo (tienen cédulas) |
| ConfigMap `asignacion-ausencias` | Se crea con `kubectl` | `ausencias.json`: ausencias de cada persona (y festivos, que solo cuentan para el balance de Análisis); lo edita coordinación |
| Job suelto | `deploy/kubernetes/job-comando.yaml` | Diagnóstico, ciclo de prueba o reversión con la misma configuración |

## Requisitos

- **Kubernetes 1.21 o superior** (CronJob `batch/v1`).
- **Un registro de imágenes** al que el clúster tenga acceso.
- **Salida a internet** hacia `api.hubapi.com:443`. Si el clúster usa NetworkPolicies, hay que permitirla.
- **Un StorageClass** con volúmenes `ReadWriteOnce`.
- **Los archivos que no están en git,** en el equipo de quien despliega: `data/analisis_riesgo/nomina.json`, `data/contratos/nomina.json`, `data/contratos/propietarios.json` y el token de producción.

## 1. Construir y publicar la imagen

Desde la raíz del repo:

```bash
VERSION=2026-11-19
docker build -t REGISTRO/asignacion-equilibrada:$VERSION .
docker run --rm REGISTRO/asignacion-equilibrada:$VERSION     # corre las pruebas del script; deben pasar todas
docker push REGISTRO/asignacion-equilibrada:$VERSION
```

`REGISTRO` es el registro de imágenes de la organización. La imagen **no** lleva el token, ni las nóminas, ni los propietarios: `.dockerignore` los excluye.

## 2. Namespace, secretos y configuración

```bash
kubectl create namespace asignacion

# Token de producción. Se toma del .env para que no quede en el historial de la terminal.
kubectl -n asignacion create secret generic asignacion-hubspot \
  --from-env-file=<(grep '^HUBSPOT_TOKEN=' .env)

# Nóminas y propietarios (tienen cédulas). Los tres archivos son obligatorios: el de propietarios puede tener la lista vacía.
kubectl -n asignacion create secret generic asignacion-datos \
  --from-file=nomina-analisis_riesgo.json=data/analisis_riesgo/nomina.json \
  --from-file=nomina-contratos.json=data/contratos/nomina.json \
  --from-file=propietarios.json=data/contratos/propietarios.json

# Festivos y ausencias
kubectl -n asignacion create configmap asignacion-ausencias \
  --from-file=ausencias.json=data/ausencias.json
```

**El token** es de la app privada de producción (cuenta 20853888). Necesita estos permisos:
- `crm.objects.custom.read` y `crm.objects.custom.write`
- `crm.schemas.custom.read`
- `crm.objects.owners.read`
- `crm.objects.deals.read`
- `crm.objects.contacts.read` y `crm.objects.contacts.write`

## 3. Desplegar

1. En `deploy/kubernetes/cronjob.yaml` y `deploy/kubernetes/job-comando.yaml`, cambia `REGISTRO/asignacion-equilibrada:VERSION` por la imagen publicada.
2. `cronjob.yaml` viene con `suspend: true`: el primer despliegue no asigna nada hasta el paso 5.

```bash
kubectl apply -f deploy/kubernetes/pvc.yaml
kubectl apply -f deploy/kubernetes/cronjob.yaml
```

## 4. Verificar antes de activar

```bash
kubectl -n asignacion create -f deploy/kubernetes/job-comando.yaml     # por defecto: --diagnostico --produccion
kubectl -n asignacion get jobs
kubectl -n asignacion logs -f job/<nombre del job que se creó>
```

El diagnóstico tiene que terminar en **«Todo listo para correr el script.»** Los `[AVISO]` no bloquean: hoy salen los parámetros viejos, la tabla de asesores que falta y la lista de propietarios vacía. Un `[ERROR]` sí bloquea, y explica qué falta.

## 5. Corte desde n8n

Hoy producción la dispara el workflow de n8n del PC de Daniel. Si n8n y el CronJob corren a la vez, cada uno con su propio candado, los dos asignarían. Por eso el orden importa:

1. **Despublicar el workflow de n8n** «disparador_algoritmo_asignacion (local, pruebas)».
2. **Opcional: copiar el log del PC al volumen,** para poder revertir con el clúster las decisiones que ya tomó n8n (ver «Ver o copiar el log»).
3. **Quitar la suspensión del CronJob:**
   ```bash
   kubectl -n asignacion patch cronjob asignacion-equilibrada -p '{"spec":{"suspend":false}}'
   ```
4. **Revisar el primer ciclo con cola:**
   ```bash
   kubectl -n asignacion get jobs --sort-by=.metadata.creationTimestamp | tail
   kubectl -n asignacion logs job/<job>
   ```
   Una asignación se ve así:
   ```
   Análisis de riesgo #… monto … → Germán E. (… reparto) [activo]
   ```

## Operación

**Apagar y encender.** Es el interruptor de apagado; equivale a `data/PAUSA`.

```bash
kubectl -n asignacion patch cronjob asignacion-equilibrada -p '{"spec":{"suspend":true}}'    # apagar
kubectl -n asignacion patch cronjob asignacion-equilibrada -p '{"spec":{"suspend":false}}'   # encender
```

**Modo sombra** (decide y registra, no escribe). En `cronjob.yaml`, quita `--activar` del valor de la variable `ARGUMENTOS` y vuelve a aplicar.

**Actualizar ausencias.** Lo pide coordinación. Aplica desde el siguiente pod, a más tardar en un minuto:

```bash
kubectl -n asignacion create configmap asignacion-ausencias --from-file=ausencias.json=data/ausencias.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

`"hasta": null` en una ausencia significa «hasta nuevo aviso».

**Actualizar nóminas o propietarios.** Es el mismo comando del paso 2, con `--dry-run=client -o yaml | kubectl apply -f -`.

**Actualizar reglas, parámetros o la tabla de asesores.** Viven en `data/` dentro de la imagen y están en git:
- `reglas.json`
- `parametros.json`
- `asesores.json`

Para cambiarlos:
1. Se cambian en el repo y se hace commit.
2. Se construye una imagen nueva con otra `VERSION`.
3. Se actualiza `image` en `cronjob.yaml` y se aplica.

`--parametros` (necesita SQL Server/AGSSA y Windows) y `--importar-asesores` (necesita el Excel de Ana) **no** corren en el clúster: se corren en un PC y el resultado se sube al repo.

**Ver o copiar el log.** El volumen es `ReadWriteOnce`. Para mirarlo se usa un pod temporal, que se borra apenas se termina, porque mientras esté vivo el CronJob podría no montar el volumen en otro nodo:

```bash
kubectl -n asignacion patch cronjob asignacion-equilibrada -p '{"spec":{"suspend":true}}'
kubectl -n asignacion run consola --image=busybox:1.36 --restart=Never \
  --overrides='{"spec":{"securityContext":{"runAsUser":1000,"fsGroup":1000},"containers":[{"name":"consola","image":"busybox:1.36","command":["sleep","3600"],"volumeMounts":[{"name":"logs","mountPath":"/logs"}]}],"volumes":[{"name":"logs","persistentVolumeClaim":{"claimName":"asignacion-logs"}}]}}'
kubectl -n asignacion wait --for=condition=Ready pod/consola
kubectl -n asignacion cp consola:/logs/decisiones.jsonl ./decisiones.jsonl     # bajar
# kubectl -n asignacion cp ./decisiones.jsonl consola:/logs/decisiones.jsonl   # subir (corte desde n8n)
kubectl -n asignacion delete pod consola
kubectl -n asignacion patch cronjob asignacion-equilibrada -p '{"spec":{"suspend":false}}'
```

**Revertir asignaciones.** Primero se suspende el CronJob. Luego, en `job-comando.yaml`:
1. Para ver qué revertiría: `command: ["node", "revertir_asignacion.ts"]` y `args: ["--produccion"]`. Se crea el Job y se leen sus logs.
2. Para revertir: `args: ["--produccion", "--aplicar"]`.

Las tareas que creó el script no se borran: se cierran a mano en HubSpot.

## Monitoreo

Cada ciclo es un Job. El Job falla si el script sale con un código distinto de 0:

| Código | Qué pasó | Qué hacer |
|---|---|---|
| `0` | Ciclo correcto, o ciclo sin nada que hacer (cola vacía, otro ciclo en curso) | Nada |
| `1` | Falló un ciclo: HubSpot respondió con error al escribir, o hubo un error de red después de los reintentos | Si se repite, leer `kubectl logs` del Job. Con 401 o 403, el token venció o perdió permisos |
| `2` | Error de configuración (falta un archivo, una nómina inválida, un `[ERROR]` del diagnóstico) o el candado lleva 10 minutos ocupado | Correr el diagnóstico (paso 4) |

- **Alerta sugerida:** más de 3 Jobs fallidos seguidos del CronJob `asignacion-equilibrada`. En Prometheus con kube-state-metrics, la métrica es `kube_job_status_failed`.
- **Alertas del script:** cada `[ALERTA]` (registro sin monto, tarea que no se pudo crear, cola de más de 200 registros) sale en los logs del pod y queda en `decisiones.jsonl`.

## Seguridad

- **El contenedor** corre sin root (usuario `node`, 1000), con el sistema de archivos de solo lectura y sin capacidades. Solo escribe en `/app/logs` (el volumen) y en `/tmp`.
- **El token y las cédulas** solo existen en los dos Secrets. No van en la imagen, ni en git, ni en los manifiestos.
- **El log** (`decisiones.jsonl`) tiene IDs de HubSpot, nombres de la nómina y montos, pero no cédulas ni tokens.
