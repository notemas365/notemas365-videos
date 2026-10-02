// actualizar-video.js
// -----------------------------------------------------------------------
// Le pregunta al backend de Apps Script cuál es el video YA CONFIRMADO
// para hoy, lo DESCARGA (los bytes reales, no solo la URL), lo COMPRIME
// (los originales de Pexels pueden pesar 90+ MB) y lo deja listo en
// videos-dia/hoy.mp4 para subirse a Hostinger junto con el resto del
// sitio. Así el visitante lo recibe directo desde el mismo dominio, ya
// liviano — sin depender de Pexels en el momento de la visita, que es
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

// Pexels entrega el archivo original en alta resolución — se han visto
// videos de ¡96 MB! para un simple fondo en loop. Eso es completamente
// inviable en hosting compartido: por bien optimizado que esté el
// archivo (ver "faststart" abajo), un celular con datos móviles tarda
// muchos segundos en recibir los primeros megas, y eso es exactamente lo
// que se veía como "pantalla negra / imagen fija que no reproduce".
//
// La solución real es REDUCIR el peso, no solo reordenar el archivo:
//   - Reescalar a un ancho máximo de 1280px (de sobra para un fondo
//     detrás de texto, que nunca se ve a pantalla completa en detalle).
//   - Quitar el audio (-an): el <video> siempre se reproduce "muted", así
//     que el audio original no sirve para nada y solo pesa.
//   - Recodificar con calidad razonable (CRF 26 — visualmente casi
//     idéntico para video de fondo, pero una fracción del peso).
// Esto normalmente baja un archivo de decenas de MB a 2-6 MB.
//
// Se combina con "+faststart" (mueve el índice/"moov atom" al frente del
// archivo) para que el navegador pueda arrancar a reproducir apenas
// llegan los primeros bytes, en vez de esperar a tener el archivo
// completo para ubicar ese índice.
//
// Si ffmpeg no está disponible o la recodificación falla por algo, se
// sube el archivo original tal cual se descargó — pesado, pero el sitio
// sigue funcionando (mismo criterio de "no romper el despliegue").
function comprimirVideo(origen, destinoFinal) {
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y", "-i", origen,
        "-vf", "scale='min(1280,iw)':-2",
        "-c:v", "libx264", "-preset", "fast", "-crf", "26",
        "-an",
        "-movflags", "+faststart",
        destinoFinal,
      ],
      { stdio: "pipe" }
    );
    fs.unlinkSync(origen);
    const pesoFinal = fs.statSync(destinoFinal).size;
    console.log(`Video comprimido a ${(pesoFinal / 1024 / 1024).toFixed(1)} MB (listo para servir desde Hostinger).`);
  } catch (error) {
    console.log("No se pudo comprimir el video (se sube el original, sin optimizar):", error.message);
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
  console.log(`Video descargado a ${temporal} (${(pesoBytes / 1024 / 1024).toFixed(1)} MB, original de Pexels).`);
  comprimirVideo(temporal, destino);

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
