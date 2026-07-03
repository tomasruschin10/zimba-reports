# Zimba Reports (estático)

Reportes de Meta Ads por cliente, **sin server y sin costo**. Un GitHub Action
corre 3×/día, trae la data de Meta, precalcula las vistas y publica páginas
estáticas en GitHub Pages. El cliente entra a un link que carga al instante.

## Cómo funciona

```
GitHub Actions (3x/día) ─▶ src/build.js ─▶ trae Meta ─▶ precalcula vistas
                                                          │
                                                          ▼
                                     public/{slug}.html + public/data/{slug}.json
                                                          │
                                                          ▼
                                          GitHub Pages (link para el cliente)
```

No hay base de datos ni server que mantener. Cada build regenera los archivos con
la data fresca. Las vistas son fijas: **Hoy, Este mes, Mes pasado, Últimos 30**
(cubren lo que un cliente mira; el cliente cambia entre ellas con botones).

## Puesta en marcha (una vez)

1. **Subí el proyecto a GitHub** (repo nuevo, público o privado).
2. **Cargá el token de Meta como secret:** en el repo → Settings → Secrets and
   variables → Actions → New repository secret. Nombre: `META_ACCESS_TOKEN`,
   valor: tu token. (Así no queda en el código.)
3. **Activá GitHub Pages:** Settings → Pages → Source: **GitHub Actions**.
4. **Corré el workflow:** pestaña Actions → "Build & Deploy reportes" → Run
   workflow. En un par de minutos publica.

El link queda `https://TU_USUARIO.github.io/REPO/chillout.html` (o tu dominio si
configurás uno en Pages). Ese es el link del cliente.

## Sumar un cliente

Editá `clients.json` y agregá un objeto con su slug, nombre y sus cuentas de Meta.
El próximo build genera su página sola.

```json
{
  "slug": "otrocliente",
  "name": "Otro Cliente",
  "sources": { "meta": { "accounts": [
    { "id": "act_XXXX", "label": "Cuenta 1" }
  ]}}
}
```

## Cambiar la frecuencia

En `.github/workflows/build.yml`, la línea `cron`. Está en UTC. Ahora corre
8, 14 y 20 UTC (≈ 10, 16, 22 hora de Madrid).

## Mantenimiento

- **Meta** rota la versión del Graph API ~cada 3 meses. Cambiá `META_API_VERSION`
  en el workflow (`v21.0` → la nueva).
- Si un build falla, GitHub te manda un mail y lo ves en la pestaña Actions.

## Probar en local

```bash
META_ACCESS_TOKEN=tu_token npm run build
cd public && python3 -m http.server 8000   # abrí http://localhost:8000/chillout.html
```

## Google / TikTok / Pinterest

Se suman con el mismo patrón: un fetcher que devuelva filas diarias, y sumar la
fuente al build. Meta tiene API estable; TikTok y Pinterest no tienen server
oficial y se envuelven a mano.
