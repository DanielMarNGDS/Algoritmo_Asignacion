# Asignación equilibrada: imagen para correr un ciclo (--una-vez) desde un CronJob de Kubernetes.
# Node 24 ejecuta los .ts directamente: no hay paso de compilación ni dependencias de ejecución (no hace falta npm install).
# Las nóminas, los propietarios (tienen cédulas) y el token NO van en la imagen: los monta el CronJob desde Secrets.
# data/ausencias.json sí viene en la imagen, pero el CronJob la reemplaza con un ConfigMap para editarla sin reconstruir.
FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node package.json asignacion_equilibrada.ts revertir_asignacion.ts ./
COPY --chown=node:node data/ ./data/
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
# Por defecto corre las pruebas (no toca HubSpot): `docker run --rm <imagen>` valida la imagen.
# El CronJob define el comando real.
CMD ["node", "asignacion_equilibrada.ts", "--autoprueba"]
