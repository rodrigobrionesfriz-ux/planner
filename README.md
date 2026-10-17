# Planificador

App web multiusuario para planificar el día, el mes y el año. Se aloja gratis en GitHub Pages y guarda los datos en Firebase (Authentication + Firestore). No necesita compilar nada: son archivos HTML, CSS y JS.

## Qué hace

- **Día:** agenda por hora, tareas con prioridad, categoría y proyecto, marcar como hechas, avance del día. Tocar una hora vacía crea una tarea a esa hora.
- **Mes:** calendario con tareas, reuniones y proyectos en curso (puntos de color), resumen y metas del mes.
- **Año:** mapa de calor de actividad por día y metas anuales o por mes.
- **Reuniones:** planificar con agenda, lugar, enlace, invitados, estado y acuerdos. Los invitados con cuenta ven la reunión en su propia app.
- **Proyectos de varios días:** hitos con fecha, avance automático, gráfico de avance real vs esperado y línea de tiempo (Gantt) con marca de hoy.
- Acceso con correo y contraseña o con Google. Cada usuario ve solo sus datos.
- **Tareas que se repiten:** cada semana (eliges los días) o cada mes (eliges el día), con fecha de término opcional. Cada repetición se marca como hecha por separado, y al editar o eliminar puedes elegir solo ese día o toda la serie. En la vista Mes aparece la lista de tareas repetitivas.
- **Seguimiento:** cada tarea de hoy o de días anteriores muestra si está *Ejecutada* o *Pendiente* (con los días de atraso), y se puede marcar con una bandera ⚑ para seguirla de cerca. La vista *Seguimiento* reúne las tareas con bandera, las pendientes de hoy y las pendientes de días anteriores, con botones para marcarlas ejecutadas o pasarlas a hoy. En la vista Día de hoy aparece un aviso si quedan pendientes atrás.
- **App instalable (PWA):** se instala en el celular o el computador como una app más, con su ícono, y abre aunque no haya conexión.
- **Hoy destacado:** en Mes y Año el día actual queda marcado en azul, y en Año también el mes en curso.
- Funciona sin conexión momentánea (caché local de Firestore) y se adapta a celular y modo oscuro.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html` | Estructura de la app |
| `styles.css` | Diseño |
| `app.js` | Lógica, vistas y conexión a Firebase |
| `firebase-config.js` | Tus credenciales de Firebase (lo único que debes editar) |
| `firestore.rules` | Reglas de seguridad para pegar en Firebase |
| `manifest.webmanifest` | Nombre, colores e íconos de la app instalable |
| `sw.js` | Service worker: guarda la app para abrirla sin conexión |
| `icons/` | Íconos de la app |

## Puesta en marcha (unos 15 minutos)

### 1. Firebase
1. Entra a https://console.firebase.google.com y crea un proyecto (Analytics es opcional).
2. **Authentication > Comenzar > Sign-in method:** activa **Correo electrónico/contraseña** y **Google**.
3. **Firestore Database > Crear base de datos:** modo producción, región cercana (por ejemplo `southamerica-east1`).
4. En Firestore, pestaña **Reglas:** borra lo que hay, pega el contenido de `firestore.rules` y presiona **Publicar**.
5. **Configuración del proyecto (engranaje) > Tus apps > Web (</>):** registra la app y copia el objeto `firebaseConfig`.
6. Pega esos valores en `firebase-config.js`.

### 2. GitHub
1. Crea un repositorio nuevo (por ejemplo `planificador`).
2. Sube los 5 archivos a la raíz (botón **Add file > Upload files**).
3. **Settings > Pages:** en *Source* elige **Deploy from a branch**, rama `main`, carpeta `/ (root)` y guarda.
4. En un par de minutos la app queda en `https://TU_USUARIO.github.io/planificador/`.

### 3. Autorizar el dominio
En Firebase: **Authentication > Settings > Authorized domains > Add domain** y agrega `TU_USUARIO.github.io`. Sin esto, el acceso con Google falla.

### Probar en tu computador (opcional)
Los módulos JS no funcionan abriendo el archivo con doble clic. Usa un servidor local en la carpeta:
```
python -m http.server 8000
```
y abre http://localhost:8000 (localhost ya viene autorizado en Firebase).

## Estructura de datos en Firestore

```
users/{uid}                      perfil: nombre, email, ultimoAcceso
users/{uid}/tareas/{id}          titulo, fecha, horaInicio, horaFin, prioridad, categoria, proyectoId, descripcion, completada, seguimiento
                                 repetir ("" | semanal | mensual), diasSemana[0-6], diaMes, hasta,
                                 hechas{fecha: true}, seguimientos{fecha: true}, excepciones[fechas]   (solo en tareas repetitivas)
users/{uid}/proyectos/{id}       nombre, descripcion, fechaInicio, fechaFin, color, avance, hitos[{texto, fecha, hecho}]
users/{uid}/metas/{id}           titulo, anio, mes (-1 = todo el año), hecha
reuniones/{id}                   titulo, fecha, horas, lugar, enlace, agenda, acuerdos, estado,
                                 participantes[emails], ownerUid, ownerEmail, ownerNombre
```

Las reglas permiten que cada usuario lea y escriba solo dentro de `users/{su uid}`. Las reuniones las edita solo quien las creó y las leen los correos invitados.

## Nota sobre la apiKey
Es normal que `firebase-config.js` quede público en GitHub. Esa clave solo identifica el proyecto; lo que protege los datos son las reglas de Firestore. Si quieres más resguardo, en Google Cloud Console puedes restringir la clave al dominio `TU_USUARIO.github.io`.

## Ideas para una siguiente fase
- Que los invitados confirmen asistencia.
- Recordatorios por notificación.
- Exportar a Excel o PDF el resumen del mes.

## Instalar la app
- **Android o computador (Chrome/Edge):** aparece el botón **Instalar app** arriba, o usa el menú del navegador > *Instalar app*.
- **iPhone (Safari):** botón Compartir > *Agregar a pantalla de inicio*.

## Publicar cambios futuros
Cada vez que cambies archivos de la app, sube el número `VERSION` en `sw.js` (por ejemplo de `v4` a `v5`). Así los equipos con la app instalada muestran el aviso "Hay una versión nueva" y se actualizan con un toque.
