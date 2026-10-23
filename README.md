# token-meter

Mod para Claude Code que muestra, encima de la caja de texto:

- **El PR de la rama**: número, repo, rama, cambios (+/−) y estado de las pruebas (CI).
- **Coste de la sesión** (exacto) y **coste en esta rama** (acumulado entre sesiones, aproximado).
- **Subagentes**: coste estimado y su peso sobre el total.
- **Reutilizado de caché**, **contexto usado** y **límites de uso** (5 h y semanal), con proyección de cuándo llegarías al 100 %, cuánto llevas gastado en esa ventana y cuándo se reinicia.
- **Datos**: hace cuánto llegó la última cifra (solo se actualiza cuando Claude responde).

Lo marcado con `~` es una estimación. En la app, al pasar el puntero por una métrica se explica qué es y por qué importa; en la terminal, el botón «Qué significa cada cosa» muestra la leyenda completa. Con suscripción, los `$` son el coste equivalente por API, no lo que pagas.

## Instalación

En una terminal, abre Claude Code (`claude`) y escribe:

```
/plugin install token-meter --marketplace valgimeno/token-meter
```

Responde `y` para añadir el marketplace y pulsa Enter para instalarlo a nivel de usuario. Desde ese momento aparece en todas tus sesiones de Claude Code, también en la pestaña Code de la app de escritorio.

La fila del PR necesita estar en un repositorio con `gh` (GitHub CLI) instalado y con sesión iniciada (`gh auth login`); si falta, la banda lo indica.

## Actualizar

Dentro de Claude Code: `/plugin update token-meter` (o `/plugin` → Installed → token-meter → Update).
