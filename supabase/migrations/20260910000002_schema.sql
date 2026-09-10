-- ============================================================================
-- Bajo Techo — 02. Esquema de negocio
--
-- Convenciones:
--   * Identificadores en inglés; la UI y los mensajes van en español.
--   * Todo valor monetario es INTEGER = pesos colombianos sin decimales.
--   * El sistema NUNCA cobra ni mueve dinero: solo registra qué se vendió.
--   * Las FK compuestas (id, brand_id) hacen estructuralmente imposible
--     cruzar datos entre marcas, aun con un bug de aplicación.
-- ============================================================================

-- ─── Enums ──────────────────────────────────────────────────────────────────
create type user_role         as enum ('store', 'brand');
create type payment_method    as enum ('card', 'cash', 'transfer');
create type import_status     as enum ('processing', 'review', 'confirmed', 'discarded');
create type import_row_status as enum ('pending', 'confirmed', 'discarded');

create type adjustment_reason as enum (
  'initial_inventory',   -- carga inicial del catálogo
  'physical_count',      -- conteo físico
  'unregistered_stock',  -- había existencias que el sistema no conocía
  'shrinkage',           -- merma, rotura, pérdida
  'return'               -- devolución de cliente
);

create type import_alert as enum (
  'total_mismatch',           -- cantidad * valor unitario != valor total (fila 24 del Excel real)
  'missing_voucher',          -- venta sin número de vaucher
  'unreadable_date',          -- fecha en texto libre, ej. "01 sep"
  'incomplete_row',           -- fila truncada (fila 25 del Excel real)
  'unknown_payment_method',   -- método de pago no reconocido
  'ambiguous_product_name'    -- el nombre coincide con varios productos
);

-- ─── Núcleo multi-tenant ────────────────────────────────────────────────────
create table tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table tenants is 'La tienda multimarca (ej. Casa Alma). Raíz del aislamiento.';

create table brands (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  name        text not null check (length(trim(name)) > 0),
  monthly_fee integer not null default 0 check (monthly_fee >= 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name),
  unique (id, tenant_id)   -- destino de FK compuesta
);
comment on column brands.monthly_fee is
  'Cuota mensual del puesto en COP. Metadato informativo: el sistema NO cobra ni lleva saldos.';

create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid not null references tenants(id) on delete restrict,
  brand_id   uuid references brands(id) on delete restrict,
  role       user_role not null,
  full_name  text not null check (length(trim(full_name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Un usuario 'brand' SIEMPRE tiene marca; uno 'store' NUNCA la tiene.
  constraint role_consistency check (
    (role = 'brand' and brand_id is not null) or
    (role = 'store' and brand_id is null)
  ),
  -- FK compuesta: la marca del perfil debe pertenecer a su misma tienda.
  foreign key (brand_id, tenant_id) references brands(id, tenant_id)
);
create index profiles_tenant_idx on profiles (tenant_id);

-- ─── Catálogo ───────────────────────────────────────────────────────────────
create table products (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete restrict,
  brand_id        uuid not null,
  sku             text check (sku is null or length(trim(sku)) > 0),
  name            text not null check (length(trim(name)) > 0),
  normalized_name text generated always as (app.normalize(name)) stored,
  price           integer not null check (price >= 0),
  stock           integer not null default 0 check (stock >= 0),
  min_stock       integer not null default 3 check (min_stock >= 0),
  photo_path      text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, brand_id),
  foreign key (brand_id, tenant_id) references brands(id, tenant_id)
);
comment on column products.stock is
  'Mantenido SOLO por triggers desde sale_items, restocks y stock_adjustments. Escribirlo directo lanza error.';
comment on column products.normalized_name is
  'Nombre canónico. El índice único impide volver a crear el mismo producto escrito de otra forma.';

create unique index products_brand_name_uq on products (brand_id, normalized_name);
create unique index products_brand_sku_uq  on products (brand_id, sku) where sku is not null;
create index products_brand_active_idx     on products (brand_id, is_active);
create index products_low_stock_idx        on products (brand_id) where stock <= min_stock;

-- Memoria de las decisiones de deduplicación del importador.
create table product_aliases (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete restrict,
  brand_id        uuid not null,
  product_id      uuid not null,
  raw_name        text not null check (length(trim(raw_name)) > 0),
  normalized_name text generated always as (app.normalize(raw_name)) stored,
  confirmed_by    uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  foreign key (product_id, brand_id) references products(id, brand_id) on delete cascade,
  foreign key (brand_id, tenant_id)  references brands(id, tenant_id)
);
comment on table product_aliases is
  'Mapea nombres sucios del Excel al producto canónico. Se confirma una vez y no se vuelve a preguntar.';
create unique index product_aliases_brand_name_uq on product_aliases (brand_id, normalized_name);

-- ─── Ventas: cabecera (transacción) + líneas (productos) ────────────────────
create table sales (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,
  brand_id       uuid not null,
  payment_method payment_method not null,
  voucher_number text check (voucher_number is null or length(trim(voucher_number)) > 0),
  sold_at        timestamptz not null default now(),
  -- Los cortes semanales del reporte del viernes van en hora de Bogotá, no UTC.
  sale_date      date generated always as ((timezone('America/Bogota', sold_at))::date) stored,
  affects_stock  boolean not null default true,
  recorded_by    uuid not null references auth.users(id),
  recorded_at    timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid references auth.users(id),
  import_row_id  uuid,
  unique (id, brand_id),
  foreign key (brand_id, tenant_id) references brands(id, tenant_id),
  constraint void_consistency check (
    (voided_at is null and voided_by is null) or
    (voided_at is not null and voided_by is not null)
  )
);
comment on table sales is
  'Una venta = una transacción = una pasada de datáfono = un vaucher. Los productos van en sale_items.';
comment on column sales.affects_stock is
  'false solo para ventas históricas importadas: ya ocurrieron antes del sistema y el stock actual ya las refleja.';
comment on column sales.voucher_number is
  'TEXT porque los vauchers reales son alfanuméricos (31RY, UGF9). Nullable porque el histórico no siempre lo trae.';

-- Un vaucher por marca por día: bloquea el doble registro de la misma compra,
-- nunca tranca un producto adicional (eso son más líneas, no más ventas),
-- y tolera que el datáfono recicle números cortos meses después.
create unique index sales_brand_date_voucher_uq
  on sales (brand_id, sale_date, voucher_number)
  where voucher_number is not null;
create index sales_brand_date_idx  on sales (brand_id, sale_date desc);
create index sales_tenant_date_idx on sales (tenant_id, sale_date desc);

create table sale_items (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null,
  tenant_id  uuid not null references tenants(id) on delete restrict,
  brand_id   uuid not null,
  product_id uuid not null,
  quantity   integer not null check (quantity > 0),
  unit_price integer not null check (unit_price >= 0),
  -- Generado: el error aritmético del Excel (1 x 60.000 = 120.000) es irrepresentable.
  line_total integer generated always as (quantity * unit_price) stored,
  -- FK compuestas: la línea, la venta y el producto son forzosamente de la misma marca.
  foreign key (sale_id, brand_id)    references sales(id, brand_id) on delete cascade,
  foreign key (product_id, brand_id) references products(id, brand_id),
  foreign key (brand_id, tenant_id)  references brands(id, tenant_id),
  -- 2 unidades del mismo producto son quantity = 2, no dos líneas.
  unique (sale_id, product_id)
);
comment on column sale_items.unit_price is
  'Precio histórico congelado en la venta. Nunca se lee de products al generar reportes.';
create index sale_items_sale_idx    on sale_items (sale_id);
create index sale_items_product_idx on sale_items (product_id);
create index sale_items_brand_idx   on sale_items (brand_id);

-- ─── Inventario ─────────────────────────────────────────────────────────────
create table restocks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  brand_id    uuid not null,
  product_id  uuid not null,
  quantity    integer not null check (quantity > 0),
  received_at timestamptz not null default now(),
  received_by uuid not null references auth.users(id),
  note        text,
  foreign key (product_id, brand_id) references products(id, brand_id),
  foreign key (brand_id, tenant_id)  references brands(id, tenant_id)
);
create index restocks_brand_idx on restocks (brand_id, received_at desc);

create table stock_adjustments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete restrict,
  brand_id   uuid not null,
  product_id uuid not null,
  delta      integer not null check (delta <> 0),
  reason     adjustment_reason not null,
  note       text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (product_id, brand_id) references products(id, brand_id),
  foreign key (brand_id, tenant_id)  references brands(id, tenant_id)
);
comment on table stock_adjustments is
  'Toda corrección de inventario queda auditada. Muchos ajustes unregistered_stock = problema de operación en la tienda.';
create index stock_adjustments_brand_idx  on stock_adjustments (brand_id, created_at desc);
create index stock_adjustments_reason_idx on stock_adjustments (brand_id, reason, created_at desc);

-- ─── Importación del Excel (nada se descarta en silencio) ───────────────────
create table imports (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  brand_id    uuid not null,
  file_name   text not null check (length(trim(file_name)) > 0),
  status      import_status not null default 'processing',
  total_rows  integer not null default 0 check (total_rows >= 0),
  ok_rows     integer not null default 0 check (ok_rows    >= 0),
  alert_rows  integer not null default 0 check (alert_rows >= 0),
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now(),
  foreign key (brand_id, tenant_id) references brands(id, tenant_id)
);
create index imports_brand_idx on imports (brand_id, uploaded_at desc);

create table import_rows (
  id               uuid primary key default gen_random_uuid(),
  import_id        uuid not null references imports(id) on delete cascade,
  tenant_id        uuid not null references tenants(id) on delete restrict,
  brand_id         uuid not null,
  sheet_name       text not null,
  source_row       integer not null check (source_row > 0),
  raw_data         jsonb not null,
  raw_product_name text,
  product_id       uuid,
  sale_item_id     uuid references sale_items(id) on delete set null,
  status           import_row_status not null default 'pending',
  alerts           import_alert[] not null default '{}',
  created_at       timestamptz not null default now(),
  foreign key (product_id, brand_id) references products(id, brand_id),
  foreign key (brand_id, tenant_id)  references brands(id, tenant_id),
  unique (import_id, sheet_name, source_row)
);
comment on column import_rows.source_row is
  'Fila literal del Excel. Toda fila con alerta es trazable a su celda de origen.';
comment on column import_rows.raw_data is
  'La fila tal como venía, sin limpiar. Fuente de verdad si la interpretación resulta equivocada.';
create index import_rows_import_idx on import_rows (import_id, source_row);
create index import_rows_alerts_idx on import_rows using gin (alerts);

alter table sales
  add constraint sales_import_row_fk
  foreign key (import_row_id) references import_rows(id) on delete set null;

-- ─── Reportes generados ─────────────────────────────────────────────────────
create table reports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  brand_id     uuid not null,
  period_start date not null,
  period_end   date not null,
  pdf_path     text,
  generated_by uuid not null references auth.users(id),
  generated_at timestamptz not null default now(),
  check (period_end >= period_start),
  foreign key (brand_id, tenant_id) references brands(id, tenant_id)
);
create index reports_brand_idx on reports (brand_id, period_start desc);
