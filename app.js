import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, GoogleAuthProvider, signInWithPopup, updateProfile, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp
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
});

function render() {
  if (!S.user) return;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("activo", b.dataset.vista === S.vista));
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  const vistas = { dia: vistaDia, mes: vistaMes, anio: vistaAnio, reuniones: vistaReuniones, proyectos: vistaProyectos };
  contenido.innerHTML = vistas[S.vista]();
  if (S.vista === "proyectos") graficoProyectos();
}

$("#fab").addEventListener("click", () => {
  if (S.vista === "reuniones") abrirReunion(null, { fecha: hoyISO() });
  else if (S.vista === "proyectos") abrirProyecto(null);
  else abrirTarea(null, { fecha: S.vista === "dia" ? S.fecha : hoyISO() });
});

/* ---------- Vista DÍA ---------- */
function itemTarea(t) {
  const p = t.proyectoId ? proyectoPorId(t.proyectoId) : null;
  return `<div class="item tarea prio-${esc(t.prioridad || "media")} ${t.completada ? "hecha" : ""}" data-accion="editar-tarea" data-id="${t.id}">
    <input type="checkbox" ${t.completada ? "checked" : ""} data-accion="toggle-tarea" data-id="${t.id}" aria-label="Completar">
    <div class="item-txt"><b>${esc(t.titulo)}</b>
      <small>${rangoHora(t)}${t.categoria ? " · " + esc(t.categoria) : ""}${p ? ` · <span class="tag" style="--c:${esc(p.color)}">${esc(p.nombre)}</span>` : ""}</small>
    </div></div>`;
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
  const tareas = S.tareas.filter((t) => t.fecha === f).sort(porHora);
  const reus = reuniones().filter((r) => r.fecha === f).sort(porHora);
  const hechas = tareas.filter((t) => t.completada).length;
  const pct = tareas.length ? Math.round((hechas / tareas.length) * 100) : 0;
  const proys = proyActivos(f);

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
    <div class="kpi"><b>${hechas}</b><span>hechas</span></div>
    <div class="kpi"><b>${reus.length}</b><span>reuniones</span></div>
    <div class="kpi ancho"><span>Avance del día ${pct}%</span><div class="barra"><i style="width:${pct}%"></i></div></div>
  </div>
  ${proys.length ? `<div class="proy-hoy">${proys.map((p) => `<span class="tag" style="--c:${esc(p.color)}">${esc(p.nombre)} ${avance(p)}%</span>`).join("")}</div>` : ""}
  <div class="acciones-rapidas">
    <button class="btn primario" data-accion="nueva-tarea">+ Tarea</button>
    <button class="btn" data-accion="nueva-reunion">+ Reunión</button>
  </div>
  ${sinHora ? `<h3>Sin hora asignada</h3><div class="lista">${sinHora}</div>` : ""}
  <h3>Agenda</h3>
  <div class="agenda">${filas}</div>`;
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
      ...S.tareas.filter((t) => t.fecha === f).map((t) => ({ t: t.titulo, c: t.completada ? "hecha" : "tar", h: t.horaInicio }))
    ].sort((a, b) => (a.h || "99").localeCompare(b.h || "99"));
    const dots = proyActivos(f).map((p) => `<i style="background:${esc(p.color)}"></i>`).join("");
    celdas += `<div class="celda ${f === hoy ? "hoy" : ""}" data-accion="ir-dia" data-fecha="${f}">
      <div class="num">${d}</div><div class="dots">${dots}</div>
      ${items.slice(0, 3).map((x) => `<div class="chip ${x.c}">${esc(x.t)}</div>`).join("")}
      ${items.length > 3 ? `<div class="mas">+${items.length - 3}</div>` : ""}</div>`;
  }
  const tMes = S.tareas.filter((t) => t.fecha?.startsWith(prefijo));
  const rMes = reus.filter((r) => r.fecha?.startsWith(prefijo));
  const metasMes = S.metas.filter((x) => x.anio === y && (x.mes === m || x.mes === -1));

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
  <h3>Metas de ${MESES[m]}</h3>
  ${listaMetas(metasMes, true)}
  ${formMeta(y, m)}`;
}

/* ---------- Vista AÑO ---------- */
function vistaAnio() {
  const y = S.anio, hoy = hoyISO();
  const conteo = {};
  S.tareas.forEach((t) => { if (t.fecha?.startsWith(String(y))) conteo[t.fecha] = (conteo[t.fecha] || 0) + 1; });
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
      const n = conteo[f] || 0; total += n;
      const nivel = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
      dias += `<span class="d n${nivel} ${f === hoy ? "hoy" : ""}" data-accion="ir-dia" data-fecha="${f}" title="${n} actividades">${d}</span>`;
    }
    const metasM = S.metas.filter((x) => x.anio === y && x.mes === m).length;
    meses += `<div class="mini-mes">
      <div class="mini-cab" data-accion="ir-mes" data-m="${m}">${cap(MESES[m])} <small>${total} act.${metasM ? ` · ${metasM} metas` : ""}</small></div>
      <div class="mini-grid">${dias}</div></div>`;
  }
  const metasAnio = S.metas.filter((x) => x.anio === y).sort((a, b) => a.mes - b.mes);

  return `
  <div class="barra-nav">
    <button class="btn chico" data-accion="anio-mover" data-n="-1">‹</button>
    <h2 class="titulo-nav">${y}</h2>
    <button class="btn chico" data-accion="anio-mover" data-n="1">›</button>
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
  "ir-dia": (d) => { S.fecha = d.fecha; S.vista = "dia"; render(); window.scrollTo(0, 0); },
  "ir-mes": (d) => { S.mes = { y: S.anio, m: Number(d.m) }; S.vista = "mes"; render(); window.scrollTo(0, 0); },
  "filtro-reu": (d) => { S.filtroReu = d.f; render(); },

  "nueva-tarea": () => abrirTarea(null, { fecha: S.fecha }),
  "nueva-en-hora": (d) => abrirTarea(null, { fecha: S.fecha, horaInicio: d.hora }),
  "editar-tarea": (d) => abrirTarea(S.tareas.find((t) => t.id === d.id)),
  "toggle-tarea": (d, e) => {
    e.stopPropagation();
    const t = S.tareas.find((x) => x.id === d.id);
    if (t) seguro(() => updateDoc(docU("tareas", t.id), { completada: !t.completada }));
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
function abrirTarea(t, def = {}) {
  const x = t || { prioridad: "media", ...def };
  const cats = [...new Set(S.tareas.map((y) => y.categoria).filter(Boolean))];
  const proys = S.proyectos.map((p) => `<option value="${p.id}" ${x.proyectoId === p.id ? "selected" : ""}>${esc(p.nombre)}</option>`).join("");
  abrirModal(t ? "Editar tarea" : "Nueva tarea", `
    <label>Título<input id="f-titulo" required value="${esc(x.titulo)}"></label>
    <div class="fila3">
      <label>Fecha<input id="f-fecha" type="date" required value="${esc(x.fecha)}"></label>
      <label>Desde<input id="f-hi" type="time" value="${esc(x.horaInicio)}"></label>
      <label>Hasta<input id="f-hf" type="time" value="${esc(x.horaFin)}"></label>
    </div>
    <div class="fila2">
      <label>Prioridad<select id="f-prio">
        ${["alta", "media", "baja"].map((p) => `<option value="${p}" ${x.prioridad === p ? "selected" : ""}>${cap(p)}</option>`).join("")}
      </select></label>
      <label>Categoría<input id="f-cat" list="lista-cats" value="${esc(x.categoria)}" placeholder="Ej: Trabajo">
        <datalist id="lista-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
    </div>
    <label>Proyecto<select id="f-proy"><option value="">Ninguno</option>${proys}</select></label>
    <label>Notas<textarea id="f-desc" rows="3">${esc(x.descripcion)}</textarea></label>
    ${t ? `<label class="check"><input id="f-hecha" type="checkbox" ${x.completada ? "checked" : ""}> Completada</label>` : ""}`,
  {
    guardar: async () => {
      const data = {
        titulo: val("f-titulo"), fecha: val("f-fecha"), horaInicio: val("f-hi"), horaFin: val("f-hf"),
        prioridad: val("f-prio"), categoria: val("f-cat"), proyectoId: val("f-proy"), descripcion: val("f-desc")
      };
      if (data.horaInicio && data.horaFin && data.horaFin < data.horaInicio) { toast("La hora de término es anterior al inicio", true); return false; }
      if (t) { data.completada = modalForm.querySelector("#f-hecha").checked; await seguro(() => updateDoc(docU("tareas", t.id), data), "Tarea actualizada"); }
      else await seguro(() => addDoc(col("tareas"), { ...data, completada: false, creado: serverTimestamp() }), "Tarea creada");
    },
    eliminar: t ? () => { if (confirm("¿Eliminar esta tarea?")) { modal.close(); seguro(() => deleteDoc(docU("tareas", t.id)), "Tarea eliminada"); } } : null
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
