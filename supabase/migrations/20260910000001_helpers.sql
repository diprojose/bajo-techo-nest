-- ============================================================================
-- Bajo Techo — 01. Esquema de helpers
-- El esquema `app` no se expone por la API. Contiene las UNICAS funciones
-- `security definer` del proyecto (hay un test que lo verifica).
-- ============================================================================

create schema if not exists app;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app.normalize(text)
-- Canonicaliza un nombre de producto para poder detectar duplicados.
-- Debe ser IMMUTABLE porque se usa en columnas generadas; por eso usa
-- translate() y no unaccent(), que no es inmutable.
--   'Portavasos planta MONSTERA de mesa  x6 unidades!' -> 'portavasos planta monstera de mesa x6 unidades'
-- ---------------------------------------------------------------------------
create or replace function app.normalize(input text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(
          translate(
            lower(input),
            'áàäâãÁÀÄÂÃéèëêÉÈËÊíìïîÍÌÏÎóòöôõÓÒÖÔÕúùüûÚÙÜÛñÑçÇ',
            'aaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunncc'
          ),
          '[^a-z0-9ñ ]', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  )
$$;

comment on function app.normalize(text) is
  'Normaliza texto para deduplicar nombres de producto. IMMUTABLE: se usa en columnas generadas.';
