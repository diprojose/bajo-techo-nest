import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

interface ErrorPostgres {
  code?: string;
  message?: string;
  details?: string;
  constraint?: string;
}

/**
 * Traduce los errores de Postgres a mensajes que una persona del mostrador
 * pueda entender, en español.
 *
 * Varias restricciones del esquema existen para atrapar errores reales del
 * negocio, así que su mensaje importa tanto como la restricción misma.
 */
export function traducirErrorPostgres(error: unknown): never {
  const e = (error ?? {}) as ErrorPostgres;
  const constraint = e.constraint ?? '';
  const mensaje = e.message ?? '';

  switch (e.code) {
    // Violación de RLS: la fila pertenece a otra marca, o a otra tienda.
    // Se responde 403 sin decir qué existía del otro lado.
    case '42501':
      throw new ForbiddenException(mensaje || 'No tiene acceso a este dato');

    case '23505': // unique_violation
      if (constraint === 'sales_brand_date_voucher_uq') {
        throw new ConflictException(
          'Ya hay una venta registrada hoy con ese número de vaucher. ' +
            'Si es la misma compra, agregue el producto a esa venta en vez de crear una nueva.',
        );
      }
      if (constraint === 'products_brand_name_uq') {
        throw new ConflictException(
          'Ya existe un producto con ese nombre. Búsquelo en el catálogo antes de crearlo de nuevo.',
        );
      }
      if (constraint === 'products_brand_sku_uq') {
        throw new ConflictException('Ya existe un producto con ese código.');
      }
      if (constraint === 'sale_items_sale_id_product_id_key') {
        throw new ConflictException(
          'Ese producto ya está en esta venta. Ajuste la cantidad en vez de agregarlo otra vez.',
        );
      }
      throw new ConflictException('Ese registro ya existe.');

    case '23514': // check_violation
      if (constraint === 'products_stock_check') {
        throw new ConflictException(
          'No hay unidades suficientes en el sistema. ' +
            'Si el producto sí está en el puesto, registre un ajuste de inventario y vuelva a intentar.',
        );
      }
      if (constraint === 'role_consistency') {
        throw new BadRequestException(
          'Un usuario de marca debe tener una marca asignada, y uno de tienda no puede tenerla.',
        );
      }
      throw new BadRequestException('Los datos no cumplen una regla del sistema.');

    case '23503': // foreign_key_violation
      throw new BadRequestException(
        'El registro hace referencia a algo que no existe o que es de otra marca.',
      );

    case '23502': // not_null_violation
      throw new BadRequestException('Falta un dato obligatorio.');

    default:
      throw new InternalServerErrorException(
        mensaje || 'No se pudo completar la operación.',
      );
  }
}
