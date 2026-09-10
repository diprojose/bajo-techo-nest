-- ============================================================================
-- Bajo Techo — 03. Triggers
--
-- Invariante central del inventario:
--   stock = Σ stock_adjustments.delta
--         + Σ restocks.quantity
--         − Σ sale_items.quantity  (solo ventas con affects_stock y no anuladas)
--
-- El stock deja de ser un número que alguien tocó y pasa a ser el resultado de
-- hechos registrados. Hay un test que verifica esta igualdad para todo producto.
-- ============================================================================

-- ─── updated_at automático ──────────────────────────────────────────────────
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tenants_touch  before update on tenants  for each row execute function app.touch_updated_at();
create trigger brands_touch   before update on brands   for each row execute function app.touch_updated_at();
create trigger profiles_touch before update on profiles for each row execute function app.touch_updated_at();
create trigger products_touch before update on products for each row execute function app.touch_updated_at();

-- ─── El stock solo lo mueven los triggers ───────────────────────────────────
-- apply_stock_delta levanta una bandera de transacción; la guardia de products
-- rechaza cualquier escritura de `stock` que no venga de aquí.

create or replace function app.apply_stock_delta(p_product_id uuid, p_delta integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_delta = 0 then
    return;
  end if;

  perform set_config('app.stock_write', 'on', true);

  update public.products
     set stock = stock + p_delta
   where id = p_product_id;

  perform set_config('app.stock_write', 'off', true);
end;
$$;

create or replace function app.guard_product_stock()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.stock_write', true), 'off') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' and new.stock <> 0 then
    raise exception
      'El stock inicial se registra con un ajuste de inventario (stock_adjustments), no al crear el producto'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and new.stock is distinct from old.stock then
    raise exception
      'El stock no se escribe directamente: use una venta, una reposición o un ajuste de inventario'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger products_guard_stock
  before insert or update on products
  for each row execute function app.guard_product_stock();

-- ─── Movimiento de stock por líneas de venta ────────────────────────────────
-- Una línea descuenta stock solo si su venta lo afecta y no está anulada.

create or replace function app.sale_item_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts boolean;
begin
  select s.affects_stock and s.voided_at is null
    into v_counts
    from public.sales s
   where s.id = coalesce(new.sale_id, old.sale_id);

  if not coalesce(v_counts, false) then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    perform app.apply_stock_delta(new.product_id, -new.quantity);
  elsif tg_op = 'UPDATE' then
    perform app.apply_stock_delta(old.product_id,  old.quantity);
    perform app.apply_stock_delta(new.product_id, -new.quantity);
  elsif tg_op = 'DELETE' then
    perform app.apply_stock_delta(old.product_id,  old.quantity);
  end if;

  return coalesce(new, old);
end;
$$;

create trigger sale_items_stock
  after insert or update or delete on sale_items
  for each row execute function app.sale_item_stock();

-- ─── Anular una venta devuelve el stock de todas sus líneas ─────────────────
create or replace function app.sale_void_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  item record;
begin
  if not new.affects_stock then
    return new;
  end if;

  -- Se anula: devolver todo.
  if old.voided_at is null and new.voided_at is not null then
    for item in select product_id, quantity from public.sale_items where sale_id = new.id loop
      perform app.apply_stock_delta(item.product_id, item.quantity);
    end loop;

  -- Se reactiva: volver a descontar.
  elsif old.voided_at is not null and new.voided_at is null then
    for item in select product_id, quantity from public.sale_items where sale_id = new.id loop
      perform app.apply_stock_delta(item.product_id, -item.quantity);
    end loop;
  end if;

  return new;
end;
$$;

create trigger sales_void_stock
  after update of voided_at on sales
  for each row execute function app.sale_void_stock();

-- ─── Reposiciones y ajustes ─────────────────────────────────────────────────
create or replace function app.restock_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.apply_stock_delta(new.product_id,  new.quantity);
  elsif tg_op = 'DELETE' then
    perform app.apply_stock_delta(old.product_id, -old.quantity);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger restocks_stock
  after insert or delete on restocks
  for each row execute function app.restock_stock();

create or replace function app.adjustment_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.apply_stock_delta(new.product_id,  new.delta);
  elsif tg_op = 'DELETE' then
    perform app.apply_stock_delta(old.product_id, -old.delta);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger stock_adjustments_stock
  after insert or delete on stock_adjustments
  for each row execute function app.adjustment_stock();

-- ─── Guardia contra escalada de privilegios ─────────────────────────────────
-- RLS filtra filas, no columnas. Sin esto, un usuario podría hacer
-- UPDATE profiles SET role = 'store' sobre su propia fila y ver toda la tienda.

create or replace function app.guard_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Sin sesión = contexto administrativo (migraciones, seeds, service_role).
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.role      is distinct from old.role
  or new.brand_id  is distinct from old.brand_id
  or new.tenant_id is distinct from old.tenant_id then
    raise exception 'No se permite modificar el rol, la marca ni la tienda del perfil'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_identity
  before update on profiles
  for each row execute function app.guard_profile_identity();

-- ─── affects_stock = false solo para histórico importado ────────────────────
-- Impide registrar a mano una venta "que no descuenta".

create or replace function app.guard_affects_stock()
returns trigger
language plpgsql
as $$
begin
  if new.affects_stock = false and new.import_row_id is null then
    raise exception
      'Solo las ventas importadas del histórico pueden no afectar el stock'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger sales_guard_affects_stock
  before insert or update on sales
  for each row execute function app.guard_affects_stock();
