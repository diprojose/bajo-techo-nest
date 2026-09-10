# Bajo Techo — API

Backend y capa de datos de Bajo Techo: NestJS sobre Supabase (Postgres + Auth +
Storage + RLS).

Es el **dueño del esquema**. Migraciones, políticas de aislamiento, seeds y las
pruebas que las verifican viven aquí. El frontend
([bajo-techo-web](../bajo-techo-web)) no consulta la base de datos: habla con este API.

**El sistema no maneja dinero.** Cada marca tiene su propio datáfono y el pago entra
directo a su cuenta. Bajo Techo registra qué se vendió y descuenta inventario; nunca
cobra, ni lleva saldos, ni mueve un peso.

Estado: **cimientos**. El importador de Excel, el registro de venta y el reporte
semanal en PDF vienen en el siguiente paso.

---

## Arrancar

Requiere Node 20+ y Docker.

```bash
npm install
npm run db:start        # levanta Supabase y aplica migraciones + seeds
cp .env.example .env    # pegue ahí las llaves que imprimió db:start
npm run start:dev       # http://localhost:3011
npm run test:e2e        # las pruebas de aislamiento
```

### Usuarios del demo

Contraseña de todos: `demo-bajo-techo-2026`

| Correo | Rol | Ve |
|---|---|---|
| `tienda@casaalma.test` | tienda | Las 3 marcas de Casa Alma |
| `nimvu@bajotecho.test` | marca | Solo Nimvu |
| `terracota@bajotecho.test` | marca | Solo Terracota Viva |

---

## El aislamiento

Es el requisito no negociable del proyecto: el fundador es dueño de una de las marcas
del local, así que una fuga entre marcas no sería un bug, sería el fin del producto.

**Todo el filtrado vive en la base de datos.** Si busca un `WHERE brand_id` en
`src/` no lo va a encontrar, y es a propósito: si el API filtrara, escondería un
fallo de política en vez de exponerlo. El caso más claro está en
`GET /api/brands` — una marca recibe una fila y la tienda recibe tres, sin un solo
`if` de por medio.

```
Navegador ──auth──▶ Supabase Auth ──JWT──▶ Navegador
Navegador ──JWT en Authorization──▶ NestJS
                                      │ verifica la firma (JWKS, ES256)
                                      │ propaga el JWT sin ampliarlo
                                      ▼
                                   Postgres  ── rol authenticated ──▶ RLS
```

El error clásico al poner un backend delante de Supabase es conectarse con la
`service_role key`. Esa llave **salta RLS por diseño**: el aislamiento dejaría de ser
una propiedad de la base de datos y pasaría a depender de que cada consulta recuerde
su filtro. Aquí no pasa, y hay cuatro candados:

1. **Políticas de RLS**, una por tabla y por comando. Nunca `FOR ALL`, y el
   `WITH CHECK` es idéntico al `USING`, así que ninguna fila puede crearse ni
   *moverse* hacia otra marca.
2. **FK compuestas** `(id, brand_id)`. Una venta con el producto de otra marca es
   estructuralmente imposible de insertar, aunque las políticas fallaran.
3. **`service_role` confinada** a `src/admin`, que no la exporta. Solo se usa para
   crear usuarios y para los seeds.
4. **Rol de Postgres con `NOBYPASSRLS`** para la conexión SQL directa
   (`RlsPoolService`), que abre transacción, hace `SET LOCAL role authenticated` y
   publica los claims del JWT.

### Las pruebas

```bash
npm run test:e2e     # requiere db:start y el API corriendo
```

86 pruebas, en dos niveles:

- **Base de datos** — sesiones reales (`signInWithPassword`, rol `authenticated`),
  nunca la conexión de administración, que saltaría RLS y haría pasar todo en falso.
  Vectores: SELECT directo y dirigido, `count()`, agregación, join y embed en ambas
  direcciones, INSERT ajeno y cruzado, UPDATE, DELETE, anulación, escalada de
  privilegios, cruce entre tiendas y acceso anónimo.
- **API por HTTP** — los mismos vectores contra los endpoints. Este nivel atrapa el
  día en que alguien "optimice" un endpoint lento cambiándolo a `service_role`: las
  políticas seguirían perfectas y las pruebas de base de datos seguirían en verde
  mientras el API reparte datos de todas las marcas.

Los **controles positivos van primero**. Sin ellos, una base vacía haría pasar cada
prueba sin probar nada: "no ves nada de la marca B" se cumple trivialmente si tampoco
ves nada tuyo.

Tres **meta-pruebas** cubren lo que todavía no existe: toda tabla de `public` debe
tener RLS y al menos una política, ninguna función `security definer` fuera de la
lista blanca, y toda vista debe ser `security_invoker`. Una tabla nueva sin RLS
revienta la suite.

**Comprobado:** desactivar RLS en una sola tabla tumba 24 pruebas en los cuatro
archivos y en los dos niveles.

---

## El esquema

12 tablas. Identificadores en inglés, mensajes en español. Todo importe es `integer`
= pesos colombianos sin decimales.

```
tenants ─┬─ brands ─┬─ profiles          (rol: store | brand)
         │          ├─ products ─── product_aliases
         │          ├─ sales ─────── sale_items
         │          ├─ restocks
         │          ├─ stock_adjustments
         │          ├─ imports ────── import_rows
         │          └─ reports
```

### Decisiones que vale la pena conocer

**Una venta es una transacción, no un producto.** `sales` es la cabecera (un vaucher,
un pago, un momento) y `sale_items` son los productos. Una clienta que compra dos
cosas en una sola pasada de datáfono genera **una** venta de dos líneas, no dos
ventas.

**Los totales cuadran por construcción.** `line_total` es una columna generada
(`quantity * unit_price`), así que el error del Excel real —fila 24: 1 × 60.000 =
120.000— es irrepresentable. `sales` no tiene columna `total`: una columna generada no
puede sumar filas hijas, y un total mantenido por trigger es justo el número que se
desincroniza en silencio.

**El vaucher es `text` y no es único por sí solo.** Los vauchers reales son
alfanuméricos (`31RY`, `UGF9`). El índice único va sobre
`(brand_id, sale_date, voucher_number)`: bloquea el doble registro de una compra, no
tranca nunca un producto adicional, y tolera que el datáfono recicle números cortos.

**El stock es derivado, no un número que alguien tocó.**

```
stock = Σ stock_adjustments.delta + Σ restocks.quantity − Σ sale_items.quantity
```

Se mantiene por triggers y escribirlo directo lanza error. Hay una prueba que verifica
esa igualdad para todo producto.

**El stock no puede quedar negativo**, pero eso nunca debe trancar al mostrador: si un
producto marca 0 y sí está en el puesto, la venta se registra con un ajuste auditado
(`unregistered_stock`) en la misma transacción.

**Las ventas no se borran.** No hay política de DELETE. Se anulan (`voided_at`) y el
trigger devuelve el stock, para que el reporte siga siendo reproducible.

**Las fechas cortan en hora de Bogotá.** `sale_date` es generada con
`timezone('America/Bogota', sold_at)`; en UTC, una venta de las 7pm del viernes caería
en la semana siguiente.

---

## Endpoints

| Ruta | Devuelve |
|---|---|
| `GET /api/health` | Estado del servicio y de la base. Público. |
| `GET /api/me` | Perfil del usuario: rol, marca, tienda. |
| `GET /api/brands` | Marcas visibles. Una para rol marca, todas las de la tienda para rol tienda. |
| `GET /api/products` | Catálogo. Acepta `?brandId=`. |
| `GET /api/products/conteo` | Número de referencias. |
| `GET /api/products/:id` · `POST` · `PATCH` · `DELETE` | CRUD de catálogo. |
| `GET /api/sales` | Ventas con sus líneas y productos. |
| `GET /api/sales/recientes` | Ventas con el total ya calculado. |
| `GET /api/sales/resumen` | Agregado por marca, vía SQL directo. |

Todas exigen sesión salvo `/health`: el guard es global, así que un endpoint nuevo
nace protegido.

---

## Estructura

```
src/
├── admin/        La ÚNICA frontera con service_role. No exporta nada.
├── auth/         Verificación de JWT (JWKS), guard global y decoradores
├── supabase/     Cliente por petición (PostgREST) y pool SQL con RLS
├── common/       Traducción de errores de Postgres al español
├── brands/       .controller · .module · .service
├── me/           .controller · .module · .service
├── products/     .controller · .module · .service · dto/
├── sales/        .controller · .module · .service · dto/
└── health/       .controller · .module · .service
supabase/         Migraciones y seeds
test/             Pruebas de aislamiento (*.e2e-spec.ts)
docs/             Material del cliente. Fuera del repositorio (ver .gitignore)
```

## Despliegue

Render, plan gratuito, región **Virginia** (la más cercana a Bogotá), emparejado con
un proyecto Supabase en `us-east-1`.

| Variable | Nota |
|---|---|
| `DATABASE_URL` | Rol dedicado con `NOBYPASSRLS`, nunca el superusuario |
| `SUPABASE_SERVICE_ROLE_KEY` | Salta RLS. Solo en el servidor. |
| `CORS_ORIGINS` | Dominio del frontend en Vercel |
| `PORT` | Lo inyecta Render |

El plan gratuito suspende el servicio tras ~15 minutos sin tráfico y tarda cerca de un
minuto en revivir. Mitigación, en orden de confiabilidad:

1. **Calentar la app 5 minutos antes de la reunión.** Lo más seguro y no depende de nada.
2. Ping externo cada 5 minutos a `/api/health` (UptimeRobot). Ese endpoint toca la
   base de datos a propósito, así que el mismo ping mantiene despiertos a Render y a
   Supabase, cuyos proyectos gratuitos se pausan tras ~7 días sin actividad.

El PDF del reporte usará `@react-pdf/renderer`, no Chrome headless: Puppeteer no cabe
de forma confiable en los 512MB del plan gratuito.

---

## Convenciones de git

### Ramas (git flow)

| Rama | Para qué |
|---|---|
| `main` | Lo que está en producción. Solo recibe merges de `release/*` y `hotfix/*`. |
| `develop` | Integración. Es la base de todo trabajo nuevo. |
| `feature/<nombre>` | Funcionalidad nueva. Sale de `develop` y vuelve a `develop`. |
| `bugfix/<nombre>` | Corrección de algo que falla en `develop`, antes de publicar. |
| `release/<versión>` | Preparación de una entrega: solo ajustes finales. |
| `hotfix/<nombre>` | Falla en producción. Sale de `main` y se mergea a `main` **y** a `develop`. |

Los merges a `develop` y `main` van con `--no-ff`, para que la rama quede visible
en el historial y se pueda revertir de un solo golpe.

### Mensajes de commit

[Conventional Commits](https://www.conventionalcommits.org): `tipo(alcance): descripción`.

| Tipo | Cuándo |
|---|---|
| `feat` | Funcionalidad nueva |
| `fix` | Corrección de un error |
| `refactor` | Cambio interno sin alterar el comportamiento |
| `test` | Pruebas |
| `docs` | Documentación |
| `style` | Formato, sin efecto en el código |
| `chore` | Configuración, dependencias, herramientas |
| `perf` | Mejora de rendimiento |

En español, en imperativo y describiendo **el efecto para quien usa el sistema**,
no el archivo que se tocó.

En este repositorio el cuerpo del commit importa más de lo normal: casi toda
decisión de esquema y de política de RLS tiene un porqué que no se deduce del
diff. Un `WITH CHECK` que parece redundante es lo único que impide que una fila
emigre a otra marca; explicarlo en el commit evita que alguien lo "simplifique"
dentro de seis meses.

### Cambios en la base de datos

Las migraciones son **inmutables una vez subidas**: nunca se edita una migración
que ya está en `develop`, se agrega otra. Todo cambio de esquema entra en el
mismo PR que sus políticas de RLS y sus pruebas de aislamiento; una tabla sin RLS
revienta la suite, que es exactamente lo que debe pasar.
