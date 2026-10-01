// actualizar-video.js
// -----------------------------------------------------------------------
// Le pregunta al backend de Apps Script cuál es el video YA CONFIRMADO
// para hoy, y lo escribe directamente en index.html (reemplazando la
// línea VIDEO_PRECARGADO_HOY), listo para subirse a Hostinger.
//
// Si algo falla (backend caído, sin internet, etc.), el script SALE SIN
// ERROR y deja index.html sin tocar — el sitio sigue funcionando con la
// lógica normal (adivina y confirma), simplemente sin la precarga extra
// de hoy. Preferimos "no actualizar hoy" a "romper el despliegue".
// -----------------------------------------------------------------------

const fs = require("fs");

const URL_BACKEND = "https://script.google.com/macros/s/AKfycbwMFbxzi_BIC59bULyZuF5PI6z9oeGMGgawxvG8TkS1UvSGzkEYksdaxh8o7kNrN2oF/exec";
const PASSWORD = process.env.PRODUCCION_PASSWORD;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// El backend (Apps Script) a veces tarda varios segundos en "despertar" si
// nadie lo ha usado en un rato, y ese primer intento puede fallar o
// devolver una página de error en vez de JSON. Si eso pasa justo en el
// despliegue nocturno y no reintentamos, VIDEO_PRECARGADO_HOY queda vacío
// y la web "adivina" un video por unos segundos antes de corregirse con
// el del Sheet (el "video fantasma"). Reintentamos un par de veces, con
// pausa de por medio, antes de rendirnos.
async function pedirVideoDeHoy() {
  const intentosMax = 3;
  for (let intento = 0; intento < intentosMax; intento++) {
    try {
      const resp = await fetch(URL_BACKEND + "?password=" + encodeURIComponent(PASSWORD) + "&dias=1");
      const datos = await resp.json();
      if (datos.ok && datos.dias && datos.dias[0] && datos.dias[0].videoActual) {
        return datos.dias[0].videoActual;
      }
      console.log(`Intento ${intento + 1}/${intentosMax}: el backend no devolvió un video válido todavía.`);
    } catch (error) {
      console.log(`Intento ${intento + 1}/${intentosMax} falló: ${error.message}`);
    }
    if (intento < intentosMax - 1) await esperar(4000 * (intento + 1));
  }
  return null;
}

async function main() {
  if (!PASSWORD) {
    console.log("Falta PRODUCCION_PASSWORD — se deja index.html sin cambios.");
    return;
  }

  const video = await pedirVideoDeHoy();
  if (!video) {
    console.log("El backend no devolvió un video válido hoy (tras varios intentos) — se deja index.html sin cambios.");
    return;
  }
  console.log("Video de hoy:", video);

  let html = fs.readFileSync("index.html", "utf8");
  const patronActual = /const VIDEO_PRECARGADO_HOY = "[^"]*";/;

  if (!patronActual.test(html)) {
    console.log("No se encontró la línea VIDEO_PRECARGADO_HOY en index.html — no se tocó nada.");
    return;
  }

  html = html.replace(patronActual, `const VIDEO_PRECARGADO_HOY = "${video}";`);
  fs.writeFileSync("index.html", html);
  console.log("index.html actualizado con el video de hoy.");
}

main();
