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

async function main() {
  if (!PASSWORD) {
    console.log("Falta PRODUCCION_PASSWORD — se deja index.html sin cambios.");
    return;
  }

  try {
    const resp = await fetch(URL_BACKEND + "?password=" + encodeURIComponent(PASSWORD) + "&dias=1");
    const datos = await resp.json();

    if (!datos.ok || !datos.dias || !datos.dias[0] || !datos.dias[0].videoActual) {
      console.log("El backend no devolvió un video válido hoy — se deja index.html sin cambios.");
      return;
    }

    const video = datos.dias[0].videoActual;
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
  } catch (error) {
    console.log("Error consultando el backend — se deja index.html sin cambios:", error.message);
  }
}

main();
