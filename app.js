import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, GoogleAuthProvider, signInWithPopup, updateProfile, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp,
  deleteField, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* =========================================================
   Inicialización
   ========================================================= */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const $ = (s) => document.querySelector(s);
const contenido = $("#contenido");
const modal = $("#modal");
const modalForm = $("#modal-form");

/* =========================================================
   Utilidades de fecha y texto
   ========================================================= */
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const hoyISO = () => iso(new Date());
const sumarDias = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const difDias = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS_LARGO = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS_CORTO = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fechaLarga = (s) => { const d = parseISO(s); return `${cap(DIAS_LARGO[d.getDay()])} ${d.getDate()} de ${MESES[d.getMonth()]} ${d.getFullYear()}`; };
const fechaCorta = (s) => { const d = parseISO(s); return `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const porHora = (a, b) => (a.horaInicio || "99").localeCompare(b.horaInicio || "99");
const rangoHora = (x) => x.horaInicio ? (x.horaFin ? `${x.horaInicio} a ${x.horaFin}` : x.horaInicio) : "Sin hora";
const urlSegura = (u) => /^https?:\/\//i.test(u || "") ? u : "";
const COLORES = ["#455a64", "#1e88e5", "#00897b", "#f4511e", "#8e24aa", "#c0ca33", "#6d4c41"];

function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast visible" + (error ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 3200);
}

async function seguro(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { console.error(e); toast("No se pudo guardar: " + (e.code || e.message), true); }
}

/* =========================================================
   Estado
   ========================================================= */
const ahora = new Date();
const S = {
  user: null,
  tareas: [], reunPropias: [], reunInvit: [], proyectos: [], metas: [],
  vista: "dia",
  fecha: hoyISO(),
  mes: { y: ahora.getFullYear(), m: ahora.getMonth() },
  anio: ahora.getFullYear(),
  filtroReu: "proximas",
  segPeriodo: 30,
  unsubs: [],
  chart: null
};

const uid = () => S.user.uid;
const miEmail = () => (S.user.email || "").toLowerCase();
const col = (nombre) => collection(db, "users", uid(), nombre);
const docU = (nombre, id) => doc(db, "users", uid(), nombre, id);

function reuniones() {
  const m = new Map();
  [...S.reunPropias, ...S.reunInvit].forEach((r) => m.set(r.id, r));
  return [...m.values()];
}
/* ---------- Tareas que se repiten ----------
   Una serie es un solo documento en "tareas" con repetir = "semanal" | "mensual".
   fecha = inicio, hasta = término opcional, diasSemana = [0..6] (0 = domingo),
   diaMes = 1..31, hechas = { "AAAA-MM-DD": true }, excepciones = ["AAAA-MM-DD"]. */
const esSerie = (t) => t.repetir === "semanal" || t.repetir === "mensual";
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0];
const LETRAS_SEMANA = { 0: "Do", 1: "Lu", 2: "Ma", 3: "Mi", 4: "Ju", 5: "Vi", 6: "Sá" };

function ocurre(t, f) {
  if (!esSerie(t)) return t.fecha === f;
  if (!t.fecha || f < t.fecha || (t.hasta && f > t.hasta) || (t.excepciones || []).includes(f)) return false;
  const d = parseISO(f);
  if (t.repetir === "semanal") return (t.diasSemana || []).includes(d.getDay());
  const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() === Math.min(Number(t.diaMes) || 1, ultimo);
}
const instancia = (t, f) => esSerie(t)
  ? { ...t, fecha: f, completada: !!(t.hechas || {})[f], seguimiento: !!(t.seguimientos || {})[f] }
  : t;

/* ---------- Seguimiento: ejecutada / pendiente / bandera ---------- */
function estadoTarea(t) {
  const hoy = hoyISO();
  if (t.completada) return { txt: "Ejecutada", cls: "ejec" };
  if (t.fecha < hoy) { const n = difDias(t.fecha, hoy); return { txt: `Pendiente · ${n} día${n === 1 ? "" : "s"}`, cls: "atras" }; }
  if (t.fecha === hoy) return { txt: "Pendiente", cls: "pend" };
  return null; // tareas futuras no llevan estado
}
// Pendientes de días anteriores (las series se revisan hasta "dias" hacia atrás)
function pendientesAnteriores(dias = 365) {
  const hoy = hoyISO(), desde = sumarDias(hoy, -dias);
  const sueltas = S.tareas.filter((t) => !esSerie(t) && t.fecha && t.fecha < hoy && t.fecha >= desde && !t.completada);
  const series = tareasEntre(desde, sumarDias(hoy, -1)).filter((t) => esSerie(t) && !t.completada);
  return [...sueltas, ...series].sort((a, b) => (a.fecha + (a.horaInicio || "")).localeCompare(b.fecha + (b.horaInicio || "")));
}
function conBandera() {
  const hoy = hoyISO(), desde = sumarDias(hoy, -365);
  const sueltas = S.tareas.filter((t) => !esSerie(t) && t.seguimiento);
  const series = S.tareas.filter((t) => esSerie(t)).flatMap((t) =>
    Object.keys(t.seguimientos || {}).filter((f) => f >= desde && ocurre(t, f)).map((f) => instancia(t, f)));
  return [...sueltas, ...series].sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
}
function marcarEjecutada(t, f, valor) {
  if (esSerie(t)) return seguro(() => updateDoc(docU("tareas", t.id), { [`hechas.${f}`]: valor ? true : deleteField() }));
  return seguro(() => updateDoc(docU("tareas", t.id), { completada: valor }));
}
function marcarBandera(t, f, valor) {
  if (esSerie(t)) return seguro(() => updateDoc(docU("tareas", t.id), { [`seguimientos.${f}`]: valor ? true : deleteField() }));
  return seguro(() => updateDoc(docU("tareas", t.id), { seguimiento: valor }));
}
function actualizarContadorSeg() {
  const claves = new Set([...pendientesAnteriores(S.segPeriodo), ...conBandera().filter((t) => !t.completada)].map((t) => t.id + "|" + t.fecha));
  const n = claves.size;
  const b = document.querySelector('#nav button[data-vista="seguimiento"] .cont');
  if (b) { b.textContent = n; b.classList.toggle("oculto", !n); }
}
const tareasEn = (f) => S.tareas.filter((t) => ocurre(t, f)).map((t) => instancia(t, f));
function tareasEntre(a, b) {
  const out = [];
  for (let f = a; f <= b; f = sumarDias(f, 1)) out.push(...tareasEn(f));
  return out;
}
function textoRep(t) {
  if (t.repetir === "semanal") return "Semanal: " + ORDEN_SEMANA.filter((n) => (t.diasSemana || []).includes(n)).map((n) => LETRAS_SEMANA[n]).join(", ");
  if (t.repetir === "mensual") return `Mensual: día ${t.diaMes}`;
  return "";
}

const proyectoPorId = (id) => S.proyectos.find((p) => p.id === id);
const proyActivos = (f) => S.proyectos.filter((p) => p.fechaInicio <= f && p.fechaFin >= f);

function avance(p) {
  const h = p.hitos || [];
  if (h.length) return Math.round((h.filter((x) => x.hecho).length / h.length) * 100);
  return Number(p.avance || 0);
}
function esperado(p) {
  const hoy = hoyISO();
  if (hoy < p.fechaInicio) return 0;
  if (hoy >= p.fechaFin) return 100;
  const total = difDias(p.fechaInicio, p.fechaFin);
  if (total <= 0) return 100;
  return Math.round((difDias(p.fechaInicio, hoy) / total) * 100);
}
function estadoProyecto(p) {
  const a = avance(p), e = esperado(p);
  if (a >= 100) return { txt: "Completado", cls: "ok" };
  if (hoyISO() < p.fechaInicio) return { txt: "Por iniciar", cls: "neutro" };
  if (hoyISO() > p.fechaFin) return { txt: "Vencido", cls: "mal" };
  if (a + 10 < e) return { txt: "Atrasado", cls: "mal" };
  return { txt: "En plazo", cls: "ok" };
}

/* =========================================================
   Autenticación
   ========================================================= */
let modoLogin = "entrar";
const MSG_AUTH = {
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/invalid-email": "El correo no es válido.",
  "auth/email-already-in-use": "Ese correo ya tiene cuenta. Usa Entrar.",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "auth/popup-closed-by-user": "Se cerró la ventana de Google.",
  "auth/unauthorized-domain": "Este dominio no está autorizado en Firebase (Authentication > Settings > Authorized domains).",
  "auth/operation-not-allowed": "Activa este método de acceso en Firebase Authentication.",
  "auth/too-many-requests": "Demasiados intentos. Espera un momento."
};
const loginMsg = (txt, ok = false) => { const el = $("#login-msg"); el.textContent = txt; el.className = "msg" + (ok ? " ok" : ""); };

document.querySelectorAll(".tabs-login button").forEach((b) => b.addEventListener("click", () => {
  modoLogin = b.dataset.modo;
  document.querySelectorAll(".tabs-login button").forEach((x) => x.classList.toggle("activo", x === b));
  $("#l-nombre").classList.toggle("oculto", modoLogin !== "registro");
  $("#btn-login").textContent = modoLogin === "registro" ? "Crear cuenta" : "Entrar";
  loginMsg("");
}));

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#l-email").value.trim(), pass = $("#l-pass").value;
  try {
    if (modoLogin === "registro") {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      const nombre = $("#l-nombre").value.trim();
      if (nombre) await updateProfile(cred.user, { displayName: nombre });
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) { loginMsg(MSG_AUTH[err.code] || err.message); }
});

$("#btn-google").addEventListener("click", async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (err) { loginMsg(MSG_AUTH[err.code] || err.message); }
});

$("#btn-reset").addEventListener("click", async () => {
  const email = $("#l-email").value.trim();
  if (!email) return loginMsg("Escribe tu correo arriba y vuelve a presionar.");
  try { await sendPasswordResetEmail(auth, email); loginMsg("Te enviamos un correo para restablecer la contraseña.", true); }
  catch (err) { loginMsg(MSG_AUTH[err.code] || err.message); }
});

$("#btn-salir").addEventListener("click", () => signOut(auth));

if (String(firebaseConfig.apiKey).includes("PEGA_AQUI")) {
  loginMsg("Falta configurar firebase-config.js con los datos de tu proyecto Firebase.");
}

onAuthStateChanged(auth, async (user) => {
  $("#cargando").classList.add("oculto");
  S.unsubs.forEach((u) => u()); S.unsubs = [];
  S.user = user;
  if (!user) {
    $("#pantalla-app").classList.add("oculto");
    $("#pantalla-login").classList.remove("oculto");
    return;
  }
  $("#pantalla-login").classList.add("oculto");
  $("#pantalla-app").classList.remove("oculto");
  $("#u-nombre").textContent = user.displayName || user.email;

  setDoc(doc(db, "users", user.uid), {
    nombre: user.displayName || "", email: miEmail(), ultimoAcceso: serverTimestamp()
  }, { merge: true }).catch(console.error);

  suscribir();
  render();
});

function suscribir() {
  const map = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const err = (e) => { console.error(e); toast("Error leyendo datos: " + e.code, true); };
  S.unsubs.push(
    onSnapshot(col("tareas"), (s) => { S.tareas = map(s); render(); }, err),
    onSnapshot(col("proyectos"), (s) => { S.proyectos = map(s); render(); }, err),
    onSnapshot(col("metas"), (s) => { S.metas = map(s); render(); }, err),
    onSnapshot(query(collection(db, "reuniones"), where("ownerUid", "==", uid())), (s) => { S.reunPropias = map(s); render(); }, err),
    onSnapshot(query(collection(db, "reuniones"), where("participantes", "array-contains", miEmail())), (s) => { S.reunInvit = map(s); render(); }, err)
  );
}

/* =========================================================
   Navegación y render
   ========================================================= */
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-vista]");
  if (!b) return;
  S.vista = b.dataset.vista;
  render();
  if (S.vista === "anio") verMesActual();
});
function verMesActual() {
  const el = document.getElementById("mes-actual");
  if (el && window.innerWidth < 760) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function render() {
  if (!S.user) return;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("activo", b.dataset.vista === S.vista));
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  const vistas = { dia: vistaDia, mes: vistaMes, anio: vistaAnio, reuniones: vistaReuniones, proyectos: vistaProyectos, seguimiento: vistaSeguimiento };
  contenido.innerHTML = vistas[S.vista]();
  actualizarContadorSeg();
  if (S.vista === "proyectos") graficoProyectos();
}

$("#fab").addEventListener("click", () => {
  if (S.vista === "reuniones") abrirReunion(null, { fecha: hoyISO() });
  else if (S.vista === "proyectos") abrirProyecto(null);
  else abrirTarea(null, { fecha: S.vista === "dia" ? S.fecha : hoyISO() });
});

/* ---------- Vista DÍA ---------- */
function itemTarea(t, { conFecha = false } = {}) {
  const p = t.proyectoId ? proyectoPorId(t.proyectoId) : null;
  const est = estadoTarea(t);
  return `<div class="item tarea prio-${esc(t.prioridad || "media")} ${t.completada ? "hecha" : ""} ${t.seguimiento ? "con-bandera" : ""}" data-accion="editar-tarea" data-id="${t.id}" data-fecha="${esc(t.fecha)}">
    <input type="checkbox" ${t.completada ? "checked" : ""} data-accion="toggle-tarea" data-id="${t.id}" data-fecha="${esc(t.fecha)}" aria-label="Marcar como ejecutada" title="${t.completada ? "Marcar como pendiente" : "Marcar como ejecutada"}">
    <div class="item-txt"><b>${esc(t.titulo)}</b>
      <small>${est ? `<span class="estado ${est.cls}">${est.txt}</span> · ` : ""}${conFecha ? fechaCorta(t.fecha) + " · " : ""}${rangoHora(t)}${esSerie(t) ? ` · <span class="rep" title="${esc(textoRep(t))}">↻ ${t.repetir === "semanal" ? "Semanal" : "Mensual"}</span>` : ""}${t.categoria ? " · " + esc(t.categoria) : ""}${p ? ` · <span class="tag" style="--c:${esc(p.color)}">${esc(p.nombre)}</span>` : ""}</small>
    </div>
    <button type="button" class="bandera ${t.seguimiento ? "activa" : ""}" data-accion="toggle-bandera" data-id="${t.id}" data-fecha="${esc(t.fecha)}"
      title="${t.seguimiento ? "Quitar bandera de seguimiento" : "Marcar para seguimiento"}" aria-label="Bandera de seguimiento" aria-pressed="${!!t.seguimiento}">⚑</button>
    </div>`;
}
function itemReunion(r) {
  const invit = r.ownerUid !== uid();
  return `<div class="item reunion ${r.estado === "cancelada" ? "cancelada" : ""}" data-accion="ver-reunion" data-id="${r.id}">
    <span class="ico">👥</span>
    <div class="item-txt"><b>${esc(r.titulo)}</b>
      <small>${rangoHora(r)}${r.lugar ? " · " + esc(r.lugar) : ""}${invit ? " · Invitado" : ""}${r.estado === "cancelada" ? " · Cancelada" : ""}</small>
    </div></div>`;
}

function vistaDia() {
  const f = S.fecha, hoy = hoyISO();
  const tareas = tareasEn(f).sort(porHora);
  const reus = reuniones().filter((r) => r.fecha === f).sort(porHora);
  const hechas = tareas.filter((t) => t.completada).length;
  const pct = tareas.length ? Math.round((hechas / tareas.length) * 100) : 0;
  const proys = proyActivos(f);
  const pendAnt = f === hoy ? pendientesAnteriores(S.segPeriodo) : [];

  const horasUsadas = [...tareas, ...reus].filter((x) => x.horaInicio).map((x) => Number(x.horaInicio.slice(0, 2)));
  const desde = Math.min(7, ...horasUsadas);
  const horaActual = new Date().getHours();
  let filas = "";
  for (let h = desde; h <= 23; h++) {
    const hh = pad(h);
    const items = [
      ...reus.filter((r) => r.horaInicio?.slice(0, 2) === hh).map(itemReunion),
      ...tareas.filter((t) => t.horaInicio?.slice(0, 2) === hh).map(itemTarea)
    ].join("");
    filas += `<div class="fila-hora ${f === hoy && h === horaActual ? "ahora" : ""}">
      <div class="hora">${hh}:00</div>
      <div class="slot" data-accion="nueva-en-hora" data-hora="${hh}:00">${items}</div></div>`;
  }
  const sinHora = [...reus.filter((r) => !r.horaInicio).map(itemReunion), ...tareas.filter((t) => !t.horaInicio).map(itemTarea)].join("");

  return `
  <div class="barra-nav">
    <button class="btn chico" data-accion="dia-mover" data-n="-1">‹</button>
    <input type="date" value="${f}" data-cambio="fecha">
    <button class="btn chico" data-accion="dia-mover" data-n="1">›</button>
    <button class="btn chico" data-accion="dia-hoy">Hoy</button>
  </div>
  <h2>${fechaLarga(f)}</h2>
  <div class="resumen">
    <div class="kpi"><b>${tareas.length}</b><span>tareas</span></div>
    <div class="kpi"><b>${hechas}</b><span>ejecutadas</span></div>
    <div class="kpi"><b>${tareas.length - hechas}</b><span>pendientes</span></div>
    <div class="kpi ancho"><span>${reus.length} reunion${reus.length === 1 ? "" : "es"} · Avance del día ${pct}%</span><div class="barra"><i style="width:${pct}%"></i></div></div>
  </div>
  ${proys.length ? `<div class="proy-hoy">${proys.map((p) => `<span class="tag" style="--c:${esc(p.color)}">${esc(p.nombre)} ${avance(p)}%</span>`).join("")}</div>` : ""}
  ${f === hoy && pendAnt.length ? `<div class="aviso-pend" data-accion="ir-seguimiento">
    <span>⚑ Tienes <b>${pendAnt.length}</b> tarea${pendAnt.length === 1 ? "" : "s"} pendiente${pendAnt.length === 1 ? "" : "s"} de días anteriores</span>
    <span class="btn chico">Revisar</span></div>` : ""}
  <div class="acciones-rapidas">
    <button class="btn primario" data-accion="nueva-tarea">+ Tarea</button>
    <button class="btn" data-accion="nueva-reunion">+ Reunión</button>
  </div>
  ${sinHora ? `<h3>Sin hora asignada</h3><div class="lista">${sinHora}</div>` : ""}
  <h3>Agenda</h3>
  <div class="agenda">${filas}</div>`;
}

/* ---------- Vista SEGUIMIENTO ---------- */
function filaSeg(t) {
  const hoy = hoyISO();
  return `<div class="fila-seg">
    ${itemTarea(t, { conFecha: true })}
    <div class="seg-acciones">
      ${t.completada
        ? `<button class="btn chico" data-accion="seg-pendiente" data-id="${t.id}" data-fecha="${esc(t.fecha)}">Volver a pendiente</button>`
        : `<button class="btn chico ok" data-accion="seg-ejecutada" data-id="${t.id}" data-fecha="${esc(t.fecha)}">✓ Ejecutada</button>`}
      ${!t.completada && t.fecha < hoy ? `<button class="btn chico" data-accion="seg-a-hoy" data-id="${t.id}" data-fecha="${esc(t.fecha)}">Pasar a hoy</button>` : ""}
    </div></div>`;
}
function vistaSeguimiento() {
  const hoy = hoyISO(), per = S.segPeriodo;
  const banderas = conBandera();
  const bAbiertas = banderas.filter((t) => !t.completada), bCerradas = banderas.filter((t) => t.completada);
  const pend = pendientesAnteriores(per).filter((t) => !t.seguimiento);
  const deHoy = tareasEn(hoy);
  const hoyPend = deHoy.filter((t) => !t.completada && !t.seguimiento);
  const ejecRec = tareasEntre(sumarDias(hoy, -6), hoy).filter((t) => t.completada).length;
  const periodos = [[7, "7 días"], [30, "30 días"], [90, "90 días"], [365, "1 año"]];
  return `
  <div class="barra-nav"><h2 class="titulo-nav">Seguimiento</h2></div>
  <div class="resumen">
    <div class="kpi"><b class="rojo">${pendientesAnteriores(per).length}</b><span>pendientes anteriores</span></div>
    <div class="kpi"><b>${bAbiertas.length}</b><span>con bandera abiertas</span></div>
    <div class="kpi"><b>${ejecRec}</b><span>ejecutadas en 7 días</span></div>
  </div>
  <p class="nota">Marca con ⚑ las tareas que quieres seguir de cerca. Las tareas de días anteriores que no marcaste como ejecutadas aparecen aquí como pendientes.</p>

  <h3>⚑ Con bandera <small>(${bAbiertas.length})</small></h3>
  ${bAbiertas.length ? `<div class="lista">${bAbiertas.map(filaSeg).join("")}</div>` : `<p class="vacio">No hay tareas con bandera pendientes.</p>`}

  <h3>Pendientes de hoy <small>(${hoyPend.length})</small></h3>
  ${hoyPend.length ? `<div class="lista">${hoyPend.sort(porHora).map(filaSeg).join("")}</div>` : `<p class="vacio">${deHoy.length ? "Todo lo de hoy está ejecutado." : "No hay tareas para hoy."}</p>`}

  <div class="cab-seccion">
    <h3>Pendientes de días anteriores <small>(${pend.length})</small></h3>
    <div class="segmento">${periodos.map(([n, l]) => `<button class="${per === n ? "activo" : ""}" data-accion="seg-periodo" data-n="${n}">${l}</button>`).join("")}</div>
  </div>
  ${pend.length ? `<div class="lista">${[...pend].reverse().map(filaSeg).join("")}</div>` : `<p class="vacio">Sin pendientes en este período. 👍</p>`}

  ${bCerradas.length ? `<h3>Con bandera ya ejecutadas <small>(${bCerradas.length})</small></h3>
  <div class="lista">${bCerradas.slice(-20).reverse().map(filaSeg).join("")}</div>
  <p class="nota">Quita la bandera ⚑ cuando ya no necesites seguirlas.</p>` : ""}`;
}

/* ---------- Vista MES ---------- */
function vistaMes() {
  const { y, m } = S.mes, hoy = hoyISO();
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const nDias = new Date(y, m + 1, 0).getDate();
  const prefijo = `${y}-${pad(m + 1)}`;
  const reus = reuniones();
  let celdas = DIAS_CORTO.map((d) => `<div class="cab">${d}</div>`).join("");
  for (let i = 0; i < offset; i++) celdas += `<div class="celda vacia"></div>`;
  for (let d = 1; d <= nDias; d++) {
    const f = `${prefijo}-${pad(d)}`;
    const items = [
      ...reus.filter((r) => r.fecha === f).map((r) => ({ t: r.titulo, c: "reu", h: r.horaInicio })),
      ...tareasEn(f).map((t) => ({ t: t.titulo, c: t.completada ? "hecha" : "tar", h: t.horaInicio }))
    ].sort((a, b) => (a.h || "99").localeCompare(b.h || "99"));
    const dots = proyActivos(f).map((p) => `<i style="background:${esc(p.color)}"></i>`).join("");
    celdas += `<div class="celda ${f === hoy ? "hoy" : ""}" data-accion="ir-dia" data-fecha="${f}">
      <div class="num">${f === hoy ? `<span class="num-hoy">${d}</span><span class="lbl-hoy">Hoy</span>` : d}</div><div class="dots">${dots}</div>
      ${items.slice(0, 3).map((x) => `<div class="chip ${x.c}">${esc(x.t)}</div>`).join("")}
      ${items.length > 3 ? `<div class="mas">+${items.length - 3}</div>` : ""}</div>`;
  }
  const iniMes = `${prefijo}-01`, finMes = `${prefijo}-${pad(nDias)}`;
  const tMes = tareasEntre(iniMes, finMes);
  const rMes = reus.filter((r) => r.fecha?.startsWith(prefijo));
  const metasMes = S.metas.filter((x) => x.anio === y && (x.mes === m || x.mes === -1));
  const series = S.tareas.filter((t) => esSerie(t) && t.fecha <= finMes && (!t.hasta || t.hasta >= iniMes))
    .sort((a, b) => a.titulo.localeCompare(b.titulo));
  const listaSeries = series.length
    ? `<div class="lista">${series.map((t) => `
      <div class="item tarea prio-${esc(t.prioridad || "media")}" data-accion="editar-serie" data-id="${t.id}">
        <span class="ico rep">↻</span>
        <div class="item-txt"><b>${esc(t.titulo)}</b>
          <small>${esc(textoRep(t))}${t.horaInicio ? " · " + rangoHora(t) : ""} · desde ${fechaCorta(t.fecha)}${t.hasta ? ` hasta ${fechaCorta(t.hasta)}` : ""}</small></div>
      </div>`).join("")}</div>`
    : `<p class="vacio">No hay tareas repetitivas este mes. Al crear una tarea, elige "Repetir" semanal o mensual.</p>`;

  return `
  <div class="barra-nav">
    <button class="btn chico" data-accion="mes-mover" data-n="-1">‹</button>
    <h2 class="titulo-nav">${cap(MESES[m])} ${y}</h2>
    <button class="btn chico" data-accion="mes-mover" data-n="1">›</button>
    <button class="btn chico" data-accion="mes-hoy">Hoy</button>
  </div>
  <div class="resumen">
    <div class="kpi"><b>${tMes.length}</b><span>tareas</span></div>
    <div class="kpi"><b>${tMes.filter((t) => t.completada).length}</b><span>hechas</span></div>
    <div class="kpi"><b>${rMes.length}</b><span>reuniones</span></div>
  </div>
  <div class="calendario">${celdas}</div>
  <h3>Tareas que se repiten</h3>
  ${listaSeries}
  <h3>Metas de ${MESES[m]}</h3>
  ${listaMetas(metasMes, true)}
  ${formMeta(y, m)}`;
}

/* ---------- Vista AÑO ---------- */
function vistaAnio() {
  const y = S.anio, hoy = hoyISO();
  const conteo = {};
  reuniones().forEach((r) => { if (r.fecha?.startsWith(String(y))) conteo[r.fecha] = (conteo[r.fecha] || 0) + 1; });

  let meses = "";
  for (let m = 0; m < 12; m++) {
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const nDias = new Date(y, m + 1, 0).getDate();
    let dias = ["L", "M", "M", "J", "V", "S", "D"].map((l, i) => `<span class="dl${i >= 5 ? " finde" : ""}">${l}</span>`).join("");
    for (let i = 0; i < offset; i++) dias += `<span></span>`;
    let total = 0;
    for (let d = 1; d <= nDias; d++) {
      const f = `${y}-${pad(m + 1)}-${pad(d)}`;
      const n = (conteo[f] || 0) + tareasEn(f).length; total += n;
      const nivel = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
      dias += `<span class="d n${nivel} ${f === hoy ? "hoy" : ""}" data-accion="ir-dia" data-fecha="${f}" title="${f === hoy ? "Hoy · " : ""}${n} actividades">${d}</span>`;
    }
    const metasM = S.metas.filter((x) => x.anio === y && x.mes === m).length;
    const esMesActual = hoy.startsWith(`${y}-${pad(m + 1)}`);
    meses += `<div class="mini-mes ${esMesActual ? "actual" : ""}" ${esMesActual ? 'id="mes-actual"' : ""}>
      <div class="mini-cab" data-accion="ir-mes" data-m="${m}">${cap(MESES[m])}${esMesActual ? ' <span class="lbl-hoy">Hoy</span>' : ""} <small>${total} act.${metasM ? ` · ${metasM} metas` : ""}</small></div>
      <div class="mini-grid">${dias}</div></div>`;
  }
  const metasAnio = S.metas.filter((x) => x.anio === y).sort((a, b) => a.mes - b.mes);

  return `
  <div class="barra-nav">
    <button class="btn chico" data-accion="anio-mover" data-n="-1">‹</button>
    <h2 class="titulo-nav">${y}</h2>
    <button class="btn chico" data-accion="anio-mover" data-n="1">›</button>
    <button class="btn chico" data-accion="anio-hoy">Hoy</button>
  </div>
  <h3>Metas del año</h3>
  ${listaMetas(metasAnio, false)}
  ${formMeta(y, -1)}
  <h3>Calendario anual</h3>
  <div class="anio-grid">${meses}</div>
  <p class="nota">Más oscuro = más actividades ese día. Toca un día para abrirlo.</p>`;
}

function listaMetas(metas, compacta) {
  if (!metas.length) return `<p class="vacio">Sin metas registradas.</p>`;
  return `<div class="lista">${metas.map((x) => `
    <div class="item meta ${x.hecha ? "hecha" : ""}">
      <input type="checkbox" ${x.hecha ? "checked" : ""} data-accion="toggle-meta" data-id="${x.id}" aria-label="Cumplida">
      <div class="item-txt"><b>${esc(x.titulo)}</b>${compacta ? "" : `<small>${x.mes === -1 ? "Todo el año" : cap(MESES[x.mes])}</small>`}</div>
      <button class="x" data-accion="borrar-meta" data-id="${x.id}" title="Eliminar">×</button>
    </div>`).join("")}</div>`;
}
function formMeta(y, m) {
  const opciones = `<option value="-1">Todo el año</option>` + MESES.map((n, i) => `<option value="${i}" ${i === m ? "selected" : ""}>${cap(n)}</option>`).join("");
  return `<form class="form-meta" data-form="meta" data-anio="${y}">
    <input name="titulo" placeholder="Nueva meta…" required>
    <select name="mes">${opciones}</select>
    <button class="btn primario chico">Agregar</button></form>`;
}

/* ---------- Vista REUNIONES ---------- */
function vistaReuniones() {
  const hoy = hoyISO();
  let lista = reuniones();
  lista = S.filtroReu === "proximas"
    ? lista.filter((r) => r.fecha >= hoy).sort((a, b) => (a.fecha + (a.horaInicio || "")).localeCompare(b.fecha + (b.horaInicio || "")))
    : lista.filter((r) => r.fecha < hoy).sort((a, b) => (b.fecha + (b.horaInicio || "")).localeCompare(a.fecha + (a.horaInicio || "")));

  const cards = lista.map((r) => {
    const invit = r.ownerUid !== uid();
    const puntos = (r.agenda || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const link = urlSegura(r.enlace);
    return `<div class="card" data-accion="ver-reunion" data-id="${r.id}">
      <div class="card-cab"><b>${esc(r.titulo)}</b><span class="badge ${esc(r.estado || "planificada")}">${cap(r.estado || "planificada")}</span></div>
      <div class="meta-linea">${fechaCorta(r.fecha)} · ${rangoHora(r)}${r.lugar ? " · " + esc(r.lugar) : ""}</div>
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener" class="enlace">Unirse a la reunión</a>` : ""}
      ${puntos.length ? `<ol class="agenda-pts">${puntos.slice(0, 4).map((p) => `<li>${esc(p)}</li>`).join("")}${puntos.length > 4 ? `<li>…</li>` : ""}</ol>` : ""}
      <div class="meta-linea">${invit ? `Organiza: ${esc(r.ownerEmail)}` : `${(r.participantes || []).length} invitados`}</div>
    </div>`;
  }).join("");

  return `
  <div class="barra-nav">
    <div class="segmento">
      <button class="${S.filtroReu === "proximas" ? "activo" : ""}" data-accion="filtro-reu" data-f="proximas">Próximas</button>
      <button class="${S.filtroReu === "pasadas" ? "activo" : ""}" data-accion="filtro-reu" data-f="pasadas">Pasadas</button>
    </div>
    <button class="btn primario chico" data-accion="nueva-reunion">+ Planificar reunión</button>
  </div>
  ${cards || `<p class="vacio">No hay reuniones ${S.filtroReu === "proximas" ? "próximas" : "pasadas"}.</p>`}`;
}

/* ---------- Vista PROYECTOS ---------- */
function vistaProyectos() {
  const ps = [...S.proyectos].sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
  if (!ps.length) return `<div class="vacio grande"><p>Aún no tienes proyectos.</p><p>Crea uno para seguir su avance a lo largo de varios días.</p>
    <button class="btn primario" data-accion="nuevo-proyecto">+ Nuevo proyecto</button></div>`;

  // Gantt
  const hoy = hoyISO();
  const ini = ps.reduce((m, p) => (p.fechaInicio < m ? p.fechaInicio : m), ps[0].fechaInicio);
  const fin = ps.reduce((m, p) => (p.fechaFin > m ? p.fechaFin : m), ps[0].fechaFin);
  const total = Math.max(1, difDias(ini, fin) + 1);
  const pos = (f) => (difDias(ini, f) / total) * 100;
  const hoyPos = hoy >= ini && hoy <= fin ? pos(hoy) : null;
  const gantt = ps.map((p) => {
    const left = pos(p.fechaInicio), width = Math.max(1.5, ((difDias(p.fechaInicio, p.fechaFin) + 1) / total) * 100);
    return `<div class="g-fila" data-accion="editar-proyecto" data-id="${p.id}">
      <div class="g-nombre">${esc(p.nombre)}</div>
      <div class="g-pista">${hoyPos !== null ? `<i class="g-hoy" style="left:${hoyPos}%"></i>` : ""}
        <div class="g-barra" style="left:${left}%;width:${width}%;--c:${esc(p.color)}"><i style="width:${avance(p)}%"></i></div>
      </div></div>`;
  }).join("");

  const cards = ps.map((p) => {
    const a = avance(p), e = esperado(p), est = estadoProyecto(p);
    const quedan = difDias(hoy, p.fechaFin);
    const hitos = (p.hitos || []).map((h, i) => `
      <label class="hito ${h.hecho ? "hecho" : ""}">
        <input type="checkbox" ${h.hecho ? "checked" : ""} data-accion="toggle-hito" data-id="${p.id}" data-i="${i}">
        <span>${esc(h.texto)}</span>${h.fecha ? `<small>${fechaCorta(h.fecha)}</small>` : ""}</label>`).join("");
    return `<div class="card proy" style="--c:${esc(p.color)}">
      <div class="card-cab"><b>${esc(p.nombre)}</b><span class="badge ${est.cls}">${est.txt}</span></div>
      <div class="meta-linea">${fechaCorta(p.fechaInicio)} al ${fechaCorta(p.fechaFin)} · ${quedan >= 0 ? `quedan ${quedan} días` : `venció hace ${-quedan} días`}</div>
      ${p.descripcion ? `<p class="desc">${esc(p.descripcion)}</p>` : ""}
      <div class="barra doble"><i style="width:${a}%"></i><b style="left:${e}%" title="Esperado a hoy"></b></div>
      <div class="meta-linea">Avance real <b>${a}%</b> · esperado a hoy ${e}%</div>
      ${hitos ? `<div class="hitos">${hitos}</div>` : ""}
      <div class="card-pie"><button class="btn chico" data-accion="editar-proyecto" data-id="${p.id}">Editar</button>
        <button class="btn chico" data-accion="tarea-proyecto" data-id="${p.id}">+ Tarea del proyecto</button></div>
    </div>`;
  }).join("");

  return `
  <div class="barra-nav"><h2 class="titulo-nav">Proyectos</h2>
    <button class="btn primario chico" data-accion="nuevo-proyecto">+ Nuevo proyecto</button></div>
  <h3>Avance real vs esperado</h3>
  <div class="grafico" style="height:${Math.max(160, ps.length * 56 + 60)}px"><canvas id="graf-proy"></canvas></div>
  <h3>Línea de tiempo</h3>
  <div class="gantt"><div class="g-escala"><span>${fechaCorta(ini)}</span><span>${fechaCorta(fin)}</span></div>${gantt}</div>
  <h3>Detalle</h3>
  ${cards}`;
}

function graficoProyectos() {
  const cv = document.getElementById("graf-proy");
  if (!cv || !window.Chart) return;
  const ps = [...S.proyectos].sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
  const txt = getComputedStyle(document.body).getPropertyValue("--texto").trim() || "#333";
  S.chart = new Chart(cv, {
    type: "bar",
    data: {
      labels: ps.map((p) => p.nombre),
      datasets: [
        { label: "Avance real", data: ps.map(avance), backgroundColor: ps.map((p) => p.color || COLORES[0]), borderRadius: 4 },
        { label: "Esperado a hoy", data: ps.map(esperado), backgroundColor: "rgba(140,140,140,.35)", borderRadius: 4 }
      ]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      scales: { x: { min: 0, max: 100, ticks: { callback: (v) => v + "%", color: txt } }, y: { ticks: { color: txt } } },
      plugins: { legend: { labels: { color: txt } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw}%` } } }
    }
  });
}

/* =========================================================
   Acciones (delegación de eventos)
   ========================================================= */
const acciones = {
  "dia-mover": (d) => { S.fecha = sumarDias(S.fecha, Number(d.n)); render(); },
  "dia-hoy": () => { S.fecha = hoyISO(); render(); },
  "mes-mover": (d) => { const x = new Date(S.mes.y, S.mes.m + Number(d.n), 1); S.mes = { y: x.getFullYear(), m: x.getMonth() }; render(); },
  "mes-hoy": () => { const x = new Date(); S.mes = { y: x.getFullYear(), m: x.getMonth() }; render(); },
  "anio-mover": (d) => { S.anio += Number(d.n); render(); },
  "anio-hoy": () => { S.anio = new Date().getFullYear(); render(); verMesActual(); },
  "ir-dia": (d) => { S.fecha = d.fecha; S.vista = "dia"; render(); window.scrollTo(0, 0); },
  "ir-mes": (d) => { S.mes = { y: S.anio, m: Number(d.m) }; S.vista = "mes"; render(); window.scrollTo(0, 0); },
  "filtro-reu": (d) => { S.filtroReu = d.f; render(); },

  "nueva-tarea": () => abrirTarea(null, { fecha: S.fecha }),
  "nueva-en-hora": (d) => abrirTarea(null, { fecha: S.fecha, horaInicio: d.hora }),
  "editar-tarea": (d) => {
    const t = S.tareas.find((x) => x.id === d.id);
    if (t) abrirTarea(t, {}, esSerie(t) ? d.fecha : null);
  },
  "editar-serie": (d) => { const t = S.tareas.find((x) => x.id === d.id); if (t) abrirTarea(t); },
  "toggle-bandera": (d, e) => {
    e.stopPropagation();
    const t = S.tareas.find((x) => x.id === d.id);
    if (!t) return;
    const actual = esSerie(t) ? !!(t.seguimientos || {})[d.fecha] : !!t.seguimiento;
    marcarBandera(t, d.fecha, !actual);
    toast(actual ? "Bandera quitada" : "Marcada para seguimiento");
  },
  "ir-seguimiento": () => { S.vista = "seguimiento"; render(); window.scrollTo(0, 0); },
  "seg-periodo": (d) => { S.segPeriodo = Number(d.n); render(); },
  "seg-ejecutada": (d) => { const t = S.tareas.find((x) => x.id === d.id); if (t) marcarEjecutada(t, d.fecha, true); },
  "seg-pendiente": (d) => { const t = S.tareas.find((x) => x.id === d.id); if (t) marcarEjecutada(t, d.fecha, false); },
  "seg-a-hoy": (d) => {
    const t = S.tareas.find((x) => x.id === d.id);
    if (!t) return;
    const hoy = hoyISO();
    if (!esSerie(t)) return seguro(() => updateDoc(docU("tareas", t.id), { fecha: hoy }), "Tarea movida a hoy");
    // Repetitiva: se crea una tarea suelta hoy y ese día se quita de la serie.
    const { id, repetir, diasSemana, diaMes, hasta, hechas, seguimientos, excepciones, creado, ...resto } = t;
    seguro(async () => {
      await addDoc(col("tareas"), { ...resto, fecha: hoy, repetir: "", completada: false, seguimiento: !!(seguimientos || {})[d.fecha], creado: serverTimestamp() });
      await updateDoc(docU("tareas", t.id), { excepciones: arrayUnion(d.fecha), [`seguimientos.${d.fecha}`]: deleteField() });
    }, "Tarea movida a hoy");
  },
  "toggle-tarea": (d, e) => {
    e.stopPropagation();
    const t = S.tareas.find((x) => x.id === d.id);
    if (!t) return;
    if (esSerie(t)) {
      const hecha = !!(t.hechas || {})[d.fecha];
      seguro(() => updateDoc(docU("tareas", t.id), { [`hechas.${d.fecha}`]: hecha ? deleteField() : true }));
    } else seguro(() => updateDoc(docU("tareas", t.id), { completada: !t.completada }));
  },

  "nueva-reunion": () => abrirReunion(null, { fecha: S.vista === "dia" ? S.fecha : hoyISO() }),
  "ver-reunion": (d, e) => { if (e.target.closest("a")) return; abrirReunion(reuniones().find((r) => r.id === d.id)); },

  "nuevo-proyecto": () => abrirProyecto(null),
  "editar-proyecto": (d) => abrirProyecto(proyectoPorId(d.id)),
  "tarea-proyecto": (d) => abrirTarea(null, { fecha: hoyISO(), proyectoId: d.id }),
  "toggle-hito": (d, e) => {
    e.stopPropagation();
    const p = proyectoPorId(d.id); if (!p) return;
    const hitos = (p.hitos || []).map((h, i) => (i === Number(d.i) ? { ...h, hecho: !h.hecho } : h));
    seguro(() => updateDoc(docU("proyectos", p.id), { hitos }));
  },

  "toggle-meta": (d) => {
    const m = S.metas.find((x) => x.id === d.id);
    if (m) seguro(() => updateDoc(docU("metas", m.id), { hecha: !m.hecha }));
  },
  "borrar-meta": (d) => { if (confirm("¿Eliminar esta meta?")) seguro(() => deleteDoc(docU("metas", d.id))); }
};

contenido.addEventListener("click", (e) => {
  const el = e.target.closest("[data-accion]");
  if (el && acciones[el.dataset.accion]) acciones[el.dataset.accion](el.dataset, e, el);
});
contenido.addEventListener("change", (e) => {
  if (e.target.dataset.cambio === "fecha" && e.target.value) { S.fecha = e.target.value; render(); }
});
contenido.addEventListener("submit", (e) => {
  const f = e.target;
  if (f.dataset.form !== "meta") return;
  e.preventDefault();
  const titulo = f.titulo.value.trim();
  if (!titulo) return;
  seguro(() => addDoc(col("metas"), { titulo, anio: Number(f.dataset.anio), mes: Number(f.mes.value), hecha: false, creado: serverTimestamp() }), "Meta agregada");
});

/* =========================================================
   Modales
   ========================================================= */
let alGuardar = null;
modalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (alGuardar) { const ok = await alGuardar(); if (ok !== false) modal.close(); }
  else modal.close();
});
modalForm.addEventListener("click", (e) => {
  const b = e.target.closest("[data-m]");
  if (!b) return;
  const acc = b.dataset.m;
  if (acc === "cerrar") modal.close();
  if (acc === "eliminar" && modalForm._eliminar) modalForm._eliminar();
  if (acc === "add-hito") $("#hitos-lista").insertAdjacentHTML("beforeend", filaHito({}));
  if (acc === "quitar-hito") b.closest(".hito-row").remove();
});
modalForm.addEventListener("change", (e) => {
  const id = e.target.id;
  if (id === "f-rep") mostrarCamposRep();
  if (id === "f-aplica") {
    const soloDia = e.target.value === "dia";
    modalForm.querySelector("#f-fecha").value = soloDia ? e.target.dataset.inst : e.target.dataset.ini;
    modalForm.querySelector("#f-fecha-lbl").firstChild.textContent = soloDia ? "Fecha" : "Inicio";
    modalForm.querySelector("#bloque-rep").classList.toggle("oculto", soloDia);
  }
});
function mostrarCamposRep() {
  const rep = val("f-rep");
  modalForm.querySelectorAll(".rep-campo").forEach((el) => el.classList.toggle("oculto", rep === "no"));
  modalForm.querySelector(".rep-semanal").classList.toggle("oculto", rep !== "semanal");
  modalForm.querySelectorAll(".rep-mensual").forEach((el) => el.classList.toggle("oculto", rep !== "mensual"));
}

function abrirModal(titulo, cuerpo, { guardar, eliminar, soloLectura = false } = {}) {
  alGuardar = guardar || null;
  modalForm._eliminar = eliminar || null;
  modalForm.innerHTML = `
    <div class="modal-cab"><h3>${titulo}</h3><button type="button" class="x" data-m="cerrar">×</button></div>
    <div class="modal-cuerpo">${cuerpo}</div>
    <div class="modal-pie">
      ${eliminar ? `<button type="button" class="btn peligro" data-m="eliminar">Eliminar</button>` : ""}
      <span class="flex"></span>
      <button type="button" class="btn" data-m="cerrar">${soloLectura ? "Cerrar" : "Cancelar"}</button>
      ${soloLectura ? "" : `<button type="submit" class="btn primario">Guardar</button>`}
    </div>`;
  modal.showModal();
  const primero = modalForm.querySelector("input:not([type=checkbox]):not([type=color]), textarea");
  if (primero && !soloLectura) setTimeout(() => primero.focus(), 50);
}
const val = (id) => modalForm.querySelector("#" + id)?.value.trim() ?? "";

/* ---------- Tarea ---------- */
function abrirTarea(t, def = {}, fechaInst = null) {
  const x = t || { prioridad: "media", ...def };
  const serie = !!t && esSerie(t);
  const inst = serie && fechaInst ? fechaInst : null;
  const cats = [...new Set(S.tareas.map((y) => y.categoria).filter(Boolean))];
  const proys = S.proyectos.map((p) => `<option value="${p.id}" ${x.proyectoId === p.id ? "selected" : ""}>${esc(p.nombre)}</option>`).join("");
  const rep = esSerie(x) ? x.repetir : "no";
  const base = parseISO(x.fecha || hoyISO());
  const diasSel = x.diasSemana?.length ? x.diasSemana : [base.getDay()];
  const diaMes = x.diaMes || base.getDate();
  const chipsDias = ORDEN_SEMANA.map((n) => `<label><input type="checkbox" class="f-dia" value="${n}" ${diasSel.includes(n) ? "checked" : ""}><span>${LETRAS_SEMANA[n]}</span></label>`).join("");
  const hechaInst = inst ? !!(t.hechas || {})[inst] : false;

  abrirModal(t ? (serie ? "Editar tarea repetitiva" : "Editar tarea") : "Nueva tarea", `
    ${inst ? `<div class="aviso-serie"><label>Aplicar cambios a<select id="f-aplica" data-inst="${esc(inst)}" data-ini="${esc(t.fecha)}">
      <option value="serie">Toda la serie</option>
      <option value="dia">Solo el ${fechaCorta(inst)}</option></select></label></div>` : ""}
    <label>Título<input id="f-titulo" required value="${esc(x.titulo)}"></label>
    <div class="fila3">
      <label id="f-fecha-lbl">${serie ? "Inicio" : "Fecha"}<input id="f-fecha" type="date" required value="${esc(x.fecha)}"></label>
      <label>Desde<input id="f-hi" type="time" value="${esc(x.horaInicio)}"></label>
      <label>Hasta<input id="f-hf" type="time" value="${esc(x.horaFin)}"></label>
    </div>
    <div id="bloque-rep">
      <div class="fila2">
        <label>Repetir<select id="f-rep">
          <option value="no" ${rep === "no" ? "selected" : ""}>No se repite</option>
          <option value="semanal" ${rep === "semanal" ? "selected" : ""}>Cada semana</option>
          <option value="mensual" ${rep === "mensual" ? "selected" : ""}>Cada mes</option>
        </select></label>
        <label class="rep-campo ${rep === "no" ? "oculto" : ""}">Termina el (opcional)<input id="f-hasta" type="date" value="${esc(x.hasta)}"></label>
      </div>
      <div class="rep-semanal ${rep !== "semanal" ? "oculto" : ""}"><span class="lbl">Días de la semana</span><div class="dias-semana">${chipsDias}</div></div>
      <label class="rep-mensual ${rep !== "mensual" ? "oculto" : ""}">Día del mes<input id="f-diames" type="number" min="1" max="31" value="${diaMes}"></label>
      <p class="nota rep-mensual ${rep !== "mensual" ? "oculto" : ""}">Si un mes no tiene ese día (por ejemplo el 31), la tarea cae el último día de ese mes.</p>
    </div>
    <div class="fila2">
      <label>Prioridad<select id="f-prio">
        ${["alta", "media", "baja"].map((p) => `<option value="${p}" ${(x.prioridad || "media") === p ? "selected" : ""}>${cap(p)}</option>`).join("")}
      </select></label>
      <label>Categoría<input id="f-cat" list="lista-cats" value="${esc(x.categoria)}" placeholder="Ej: Trabajo">
        <datalist id="lista-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
    </div>
    <label>Proyecto<select id="f-proy"><option value="">Ninguno</option>${proys}</select></label>
    <label>Notas<textarea id="f-desc" rows="3">${esc(x.descripcion)}</textarea></label>
    ${inst ? `<label class="check"><input id="f-hecha" type="checkbox" ${hechaInst ? "checked" : ""}> Ejecutada el ${fechaCorta(inst)}</label>`
      : t && !serie ? `<label class="check"><input id="f-hecha" type="checkbox" ${x.completada ? "checked" : ""}> Ejecutada</label>` : ""}
    ${!serie || inst ? `<label class="check"><input id="f-bandera" type="checkbox" ${(inst ? !!(t.seguimientos || {})[inst] : !!x.seguimiento) ? "checked" : ""}> ⚑ Marcar para seguimiento</label>` : ""}`,
  {
    guardar: async () => {
      const comun = {
        titulo: val("f-titulo"), fecha: val("f-fecha"), horaInicio: val("f-hi"), horaFin: val("f-hf"),
        prioridad: val("f-prio"), categoria: val("f-cat"), proyectoId: val("f-proy"), descripcion: val("f-desc")
      };
      if (comun.horaInicio && comun.horaFin && comun.horaFin < comun.horaInicio) { toast("La hora de término es anterior al inicio", true); return false; }
      const hechaChk = modalForm.querySelector("#f-hecha")?.checked || false;
      const banderaChk = modalForm.querySelector("#f-bandera")?.checked || false;

      // Cambiar solo un día de la serie: se crea una tarea suelta y ese día se excluye de la serie.
      if (inst && val("f-aplica") === "dia") {
        await seguro(async () => {
          await addDoc(col("tareas"), { ...comun, repetir: "", completada: hechaChk, seguimiento: banderaChk, creado: serverTimestamp() });
          await updateDoc(docU("tareas", t.id), { excepciones: arrayUnion(inst), [`seguimientos.${inst}`]: deleteField() });
        }, "Cambio guardado solo para ese día");
        return;
      }

      const repetir = val("f-rep");
      const data = { ...comun, repetir: repetir === "no" ? "" : repetir };
      if (repetir !== "no") {
        data.hasta = val("f-hasta");
        if (data.hasta && data.hasta < data.fecha) { toast("La fecha de término es anterior al inicio", true); return false; }
        if (repetir === "semanal") {
          data.diasSemana = [...modalForm.querySelectorAll(".f-dia:checked")].map((c) => Number(c.value));
          if (!data.diasSemana.length) { toast("Elige al menos un día de la semana", true); return false; }
        } else {
          data.diaMes = Math.min(31, Math.max(1, Math.round(Number(val("f-diames")) || 1)));
        }
      }

      if (t) {
        if (inst) {
          data[`hechas.${inst}`] = hechaChk ? true : deleteField();
          data[`seguimientos.${inst}`] = banderaChk ? true : deleteField();
        } else if (!serie && repetir === "no") { data.completada = hechaChk; data.seguimiento = banderaChk; }
        await seguro(() => updateDoc(docU("tareas", t.id), data), repetir === "no" ? "Tarea actualizada" : "Serie actualizada");
      } else {
        await seguro(() => addDoc(col("tareas"), { ...data, completada: false, seguimiento: repetir === "no" && banderaChk, creado: serverTimestamp() }),
          repetir === "no" ? "Tarea creada" : "Tarea repetitiva creada");
      }
    },
    eliminar: t ? () => {
      if (inst && val("f-aplica") === "dia") {
        if (confirm(`¿Quitar esta tarea solo del ${fechaCorta(inst)}? El resto de la serie se mantiene.`)) {
          modal.close(); seguro(() => updateDoc(docU("tareas", t.id), { excepciones: arrayUnion(inst) }), "Quitada de ese día");
        }
        return;
      }
      const msg = serie ? "¿Eliminar toda la serie? La tarea desaparece de todos los días." : "¿Eliminar esta tarea?";
      if (confirm(msg)) { modal.close(); seguro(() => deleteDoc(docU("tareas", t.id)), serie ? "Serie eliminada" : "Tarea eliminada"); }
    } : null
  });
}

/* ---------- Reunión ---------- */
function abrirReunion(r, def = {}) {
  if (r && r.ownerUid !== uid()) return verReunion(r);
  const x = r || { estado: "planificada", ...def };
  abrirModal(r ? "Editar reunión" : "Planificar reunión", `
    <label>Tema<input id="r-titulo" required value="${esc(x.titulo)}"></label>
    <div class="fila3">
      <label>Fecha<input id="r-fecha" type="date" required value="${esc(x.fecha)}"></label>
      <label>Desde<input id="r-hi" type="time" value="${esc(x.horaInicio)}"></label>
      <label>Hasta<input id="r-hf" type="time" value="${esc(x.horaFin)}"></label>
    </div>
    <div class="fila2">
      <label>Lugar<input id="r-lugar" value="${esc(x.lugar)}" placeholder="Oficina, sala…"></label>
      <label>Enlace<input id="r-enlace" type="url" value="${esc(x.enlace)}" placeholder="https://meet…"></label>
    </div>
    <label>Invitados (correos separados por coma)<textarea id="r-part" rows="2" placeholder="ana@correo.cl, juan@correo.cl">${esc((x.participantes || []).join(", "))}</textarea></label>
    <p class="nota">Los invitados que tengan cuenta en la app verán esta reunión en su planificador.</p>
    <label>Agenda (un punto por línea)<textarea id="r-agenda" rows="4">${esc(x.agenda)}</textarea></label>
    <label>Estado<select id="r-estado">
      ${["planificada", "realizada", "cancelada"].map((s) => `<option value="${s}" ${x.estado === s ? "selected" : ""}>${cap(s)}</option>`).join("")}
    </select></label>
    <label>Acuerdos y pendientes<textarea id="r-acuerdos" rows="3">${esc(x.acuerdos)}</textarea></label>`,
  {
    guardar: async () => {
      const participantes = [...new Set(val("r-part").toLowerCase().split(/[\s,;]+/)
        .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e !== miEmail()))];
      const data = {
        titulo: val("r-titulo"), fecha: val("r-fecha"), horaInicio: val("r-hi"), horaFin: val("r-hf"),
        lugar: val("r-lugar"), enlace: val("r-enlace"), participantes, agenda: val("r-agenda"),
        estado: val("r-estado"), acuerdos: val("r-acuerdos"),
        ownerUid: uid(), ownerEmail: miEmail(), ownerNombre: S.user.displayName || ""
      };
      if (data.horaInicio && data.horaFin && data.horaFin < data.horaInicio) { toast("La hora de término es anterior al inicio", true); return false; }
      if (r) await seguro(() => updateDoc(doc(db, "reuniones", r.id), data), "Reunión actualizada");
      else await seguro(() => addDoc(collection(db, "reuniones"), { ...data, creado: serverTimestamp() }), "Reunión planificada");
    },
    eliminar: r ? () => { if (confirm("¿Eliminar esta reunión? Desaparecerá también para los invitados.")) { modal.close(); seguro(() => deleteDoc(doc(db, "reuniones", r.id)), "Reunión eliminada"); } } : null
  });
}

function verReunion(r) {
  const puntos = (r.agenda || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const link = urlSegura(r.enlace);
  abrirModal(esc(r.titulo), `
    <p><b>${fechaLarga(r.fecha)}</b><br>${rangoHora(r)}${r.lugar ? " · " + esc(r.lugar) : ""}</p>
    ${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener">Unirse a la reunión</a></p>` : ""}
    <p class="nota">Organiza: ${esc(r.ownerNombre || r.ownerEmail)} · Estado: ${cap(r.estado || "planificada")}</p>
    ${puntos.length ? `<h4>Agenda</h4><ol>${puntos.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>` : ""}
    ${r.acuerdos ? `<h4>Acuerdos</h4><p class="pre">${esc(r.acuerdos)}</p>` : ""}
    <h4>Invitados</h4><p>${(r.participantes || []).map(esc).join(", ")}</p>`, { soloLectura: true });
}

/* ---------- Proyecto ---------- */
function filaHito(h) {
  return `<div class="hito-row">
    <input type="checkbox" class="h-hecho" ${h.hecho ? "checked" : ""} aria-label="Hecho">
    <input class="h-texto" placeholder="Hito o etapa" value="${esc(h.texto)}">
    <input type="date" class="h-fecha" value="${esc(h.fecha)}">
    <button type="button" class="x" data-m="quitar-hito" title="Quitar">×</button></div>`;
}

function abrirProyecto(p) {
  const hoy = hoyISO();
  const x = p || { fechaInicio: hoy, fechaFin: sumarDias(hoy, 14), color: COLORES[S.proyectos.length % COLORES.length], avance: 0, hitos: [] };
  abrirModal(p ? "Editar proyecto" : "Nuevo proyecto", `
    <label>Nombre<input id="p-nombre" required value="${esc(x.nombre)}"></label>
    <label>Descripción<textarea id="p-desc" rows="2">${esc(x.descripcion)}</textarea></label>
    <div class="fila3">
      <label>Inicio<input id="p-ini" type="date" required value="${esc(x.fechaInicio)}"></label>
      <label>Término<input id="p-fin" type="date" required value="${esc(x.fechaFin)}"></label>
      <label>Color<input id="p-color" type="color" value="${esc(x.color)}"></label>
    </div>
    <h4>Hitos o etapas</h4>
    <p class="nota">Si agregas hitos, el avance se calcula solo según los que marques como hechos.</p>
    <div id="hitos-lista">${(x.hitos || []).map(filaHito).join("")}</div>
    <button type="button" class="btn chico" data-m="add-hito">+ Agregar hito</button>
    <label>Avance manual (solo si no hay hitos): <output id="p-av-out">${Number(x.avance || 0)}%</output>
      <input id="p-av" type="range" min="0" max="100" step="5" value="${Number(x.avance || 0)}"
        oninput="document.getElementById('p-av-out').textContent=this.value+'%'"></label>`,
  {
    guardar: async () => {
      const hitos = [...modalForm.querySelectorAll(".hito-row")].map((row) => ({
        texto: row.querySelector(".h-texto").value.trim(),
        fecha: row.querySelector(".h-fecha").value,
        hecho: row.querySelector(".h-hecho").checked
      })).filter((h) => h.texto);
      const data = {
        nombre: val("p-nombre"), descripcion: val("p-desc"), fechaInicio: val("p-ini"), fechaFin: val("p-fin"),
        color: val("p-color"), avance: Number(val("p-av")), hitos
      };
      if (data.fechaFin < data.fechaInicio) { toast("La fecha de término es anterior al inicio", true); return false; }
      if (p) await seguro(() => updateDoc(docU("proyectos", p.id), data), "Proyecto actualizado");
      else await seguro(() => addDoc(col("proyectos"), { ...data, creado: serverTimestamp() }), "Proyecto creado");
    },
    eliminar: p ? () => { if (confirm("¿Eliminar este proyecto? Las tareas asociadas se mantienen.")) { modal.close(); seguro(() => deleteDoc(docU("proyectos", p.id)), "Proyecto eliminado"); } } : null
  });
}

/* =========================================================
   App instalable (PWA)
   ========================================================= */
let promptInstalar = null;
const btnInstalar = $("#btn-instalar");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  promptInstalar = e;
  btnInstalar.classList.remove("oculto");
});
btnInstalar.addEventListener("click", async () => {
  if (!promptInstalar) return;
  promptInstalar.prompt();
  await promptInstalar.userChoice;
  promptInstalar = null;
  btnInstalar.classList.add("oculto");
});
window.addEventListener("appinstalled", () => { btnInstalar.classList.add("oculto"); toast("Planificador instalado"); });

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      const avisar = (sw) => {
        $("#aviso-version").classList.remove("oculto");
        $("#btn-actualizar").onclick = () => sw.postMessage("actualizar");
      };
      if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const nuevo = reg.installing;
        nuevo?.addEventListener("statechange", () => {
          if (nuevo.state === "installed" && navigator.serviceWorker.controller) avisar(nuevo);
        });
      });
      let recargando = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (recargando) return;
        recargando = true;
        location.reload();
      });
      // Revisa si hay versión nueva al volver a la app.
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    } catch (e) { console.warn("Service worker no registrado", e); }
  });
}

// Si la app queda abierta de un día para otro, refresca para que "Hoy" se mueva solo.
let ultimoDia = hoyISO();
setInterval(() => {
  if (hoyISO() !== ultimoDia) {
    if (S.fecha === ultimoDia) S.fecha = hoyISO();
    ultimoDia = hoyISO();
    if (!modal.open) render();
  }
}, 60000);
