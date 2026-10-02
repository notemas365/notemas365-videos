// actualizar-video.js
// -----------------------------------------------------------------------
// Le pregunta al backend de Apps Script cuál es el video YA CONFIRMADO
// para hoy, lo DESCARGA (los bytes reales, no solo la URL) y lo deja
// listo en videos-dia/hoy.mp4 para subirse a Hostinger junto con el
// resto del sitio. Así el visitante lo recibe directo desde el mismo
// dominio — sin depender de Pexels en el momento de la visita, que es
// justo lo que causaba las esperas largas (a veces Pexels tarda, o el
// video nunca termina de llegar).
//
// También reescribe en index.html las líneas VIDEO_PRECARGADO_HOY (apunta
// a esa copia local) y VIDEO_PRECARGADO_FECHA (la fecha de hoy, para que
// el sitio nunca use por error la copia de un día anterior si este script
// llegara a fallar una noche).
//
// Si algo falla (backend caído, sin internet, Pexels no responde, etc.),
// el script SALE SIN ERROR y deja index.html sin tocar — el sitio sigue
// funcionando con la lógica normal (video real del Sheet vía Pexels).
// Preferimos "no actualizar hoy" a "romper el despliegue".
// -----------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const URL_BACKEND = "https://script.google.com/macros/s/AKfycbwMFbxzi_BIC59bULyZuF5PI6z9oeGMGgawxvG8TkS1UvSGzkEYksdaxh8o7kNrN2oF/exec";
const PASSWORD = process.env.PRODUCCION_PASSWORD;
const CARPETA_VIDEO_LOCAL = "videos-dia";
const ARCHIVO_VIDEO_LOCAL = "hoy.mp4";
const ARCHIVO_TEMPORAL = "hoy.descarga.mp4";

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// El backend (Apps Script) a veces tarda varios segundos en "despertar" si
// nadie lo ha usado en un rato, y ese primer intento puede fallar o
// devolver una página de error en vez de JSON. Reintentamos un par de
// veces, con pausa de por medio, antes de rendirnos.
async function pedirVideoDeHoy() {
  const intentosMax = 3;
  for (let intento = 0; intento < intentosMax; intento++) {
    try {
      const resp = await fetch(URL_BACKEND + "?password=" + encodeURIComponent(PASSWORD) + "&dias=1");
      const datos = await resp.json();
      if (datos.ok && datos.dias && datos.dias[0] && datos.dias[0].videoActual) {
        return { url: datos.dias[0].videoActual, fechaISO: datos.dias[0].fechaISO };
      }
      console.log(`Intento ${intento + 1}/${intentosMax}: el backend no devolvió un video válido todavía.`);
    } catch (error) {
      console.log(`Intento ${intento + 1}/${intentosMax} falló: ${error.message}`);
    }
    if (intento < intentosMax - 1) await esperar(4000 * (intento + 1));
  }
  return null;
}

// Descarga el archivo de video completo (los bytes, no solo la URL) a
// disco. Si Pexels responde lento o falla, lanza error — el llamador
// decide qué hacer (dejar index.html sin tocar, en este caso).
async function descargarVideo(url, destinoTemporal) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Pexels respondió ${resp.status} al descargar el video`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.mkdirSync(path.dirname(destinoTemporal), { recursive: true });
  fs.writeFileSync(destinoTemporal, buffer);
  return buffer.length;
}

// Los videos de Pexels (y la mayoría de stock footage) traen el índice
// interno del archivo ("moov atom") al FINAL en vez de al principio. Eso
// no importa cuando el navegador lo pide por streaming a un CDN grande,
// pero significa que, aunque el archivo ya esté en nuestro propio
// servidor, el navegador igual tiene que esperar a ubicar ese índice
// antes de poder mostrar el primer cuadro — y eso se ve como 1-2
// segundos de pantalla negra incluso con el video ya local. Reescribimos
// el archivo con ffmpeg para mover ese índice al frente ("faststart"),
// así el video arranca de inmediato apenas llegan los primeros bytes.
// Si ffmpeg no está disponible o falla por algo, usamos el archivo tal
// cual se descargó — sigue funcionando, solo sin esta mejora.
function moverIndiceAlFrente(origen, destinoFinal) {
  try {
    execFileSync("ffmpeg", ["-y", "-i", origen, "-c", "copy", "-movflags", "+faststart", destinoFinal], { stdio: "pipe" });
    fs.unlinkSync(origen);
    console.log("Video reescrito con 'faststart' (arranque instantáneo).");
  } catch (error) {
    console.log("No se pudo aplicar 'faststart' (se deja el video tal cual se descargó):", error.message);
    fs.renameSync(origen, destinoFinal);
  }
}

async function main() {
  if (!PASSWORD) {
    console.log("Falta PRODUCCION_PASSWORD — se deja index.html sin cambios.");
    return;
  }

  const confirmado = await pedirVideoDeHoy();
  if (!confirmado) {
    console.log("El backend no devolvió un video válido hoy (tras varios intentos) — se deja index.html sin cambios.");
    return;
  }
  console.log("Video de hoy:", confirmado.url, "— fecha:", confirmado.fechaISO);

  const destino = path.join(CARPETA_VIDEO_LOCAL, ARCHIVO_VIDEO_LOCAL);
  const temporal = path.join(CARPETA_VIDEO_LOCAL, ARCHIVO_TEMPORAL);
  let pesoBytes;
  try {
    pesoBytes = await descargarVideo(confirmado.url, temporal);
  } catch (error) {
    console.log("No se pudo descargar el video de hoy — se deja index.html sin cambios:", error.message);
    return;
  }
  console.log(`Video descargado a ${temporal} (${(pesoBytes / 1024 / 1024).toFixed(1)} MB).`);
  moverIndiceAlFrente(temporal, destino);

  let html = fs.readFileSync("index.html", "utf8");
  const patronHoy = /const VIDEO_PRECARGADO_HOY = "[^"]*";/;
  const patronFecha = /const VIDEO_PRECARGADO_FECHA = "[^"]*";/;

  if (!patronHoy.test(html) || !patronFecha.test(html)) {
    console.log("No se encontraron las líneas VIDEO_PRECARGADO_HOY / VIDEO_PRECARGADO_FECHA en index.html — no se tocó nada.");
    return;
  }

  // Query de caché con la fecha: el nombre del archivo en disco siempre es
  // el mismo (hoy.mp4, se sobreescribe cada día), así que sin esto el
  // navegador de un visitante que ya vio el sitio ayer podría seguir
  // usando SU copia en caché de "ayer" en vez de pedir la de hoy.
  const videoConCache = `${CARPETA_VIDEO_LOCAL}/${ARCHIVO_VIDEO_LOCAL}?d=${confirmado.fechaISO}`;

  html = html.replace(patronHoy, `const VIDEO_PRECARGADO_HOY = "${videoConCache}";`);
  html = html.replace(patronFecha, `const VIDEO_PRECARGADO_FECHA = "${confirmado.fechaISO}";`);
  fs.writeFileSync("index.html", html);
  console.log("index.html actualizado con la copia local del video de hoy.");
}

main();
