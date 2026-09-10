import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { RequestSupabaseService } from '../supabase/request-supabase.service';
import { traducirErrorPostgres } from '../common/errores-postgres';

/**
 * Catálogo.
 *
 * Fíjese en lo que NO aparece en ninguna consulta: un `WHERE brand_id`. No hace
 * falta y no debe estar. El filtrado vive en las políticas de RLS; si este
 * servicio filtrara, escondería un fallo de política en vez de exponerlo.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly supabase: RequestSupabaseService) {}

  async findAll(filtros: ListProductsDto) {
    let consulta = this.supabase.db
      .from('products')
      .select('*')
      .order('name', { ascending: true });

    // Un usuario de marca que pida otra marca recibe cero filas, no un error:
    // RLS intersecta este filtro con lo que ya puede ver.
    if (filtros.brandId) consulta = consulta.eq('brand_id', filtros.brandId);
    if (filtros.soloActivos === 'true') consulta = consulta.eq('is_active', true);

    const { data, error } = await consulta;
    if (error) traducirErrorPostgres(error);
    return data;
  }

  async count(filtros: ListProductsDto) {
    let consulta = this.supabase.db
      .from('products')
      .select('*', { count: 'exact', head: true });

    if (filtros.brandId) consulta = consulta.eq('brand_id', filtros.brandId);

    const { count, error } = await consulta;
    if (error) traducirErrorPostgres(error);
    return { total: count ?? 0 };
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) traducirErrorPostgres(error);
    if (!data) throw new NotFoundException('Producto no encontrado');
    return data;
  }

  async create(dto: CreateProductDto) {
    // `tenant_id` no se recibe del cliente: se deriva de la marca, y RLS
    // verifica que esa marca sea alcanzable para quien está pidiendo.
    const { data: marca, error: errorMarca } = await this.supabase.db
      .from('brands')
      .select('id, tenant_id')
      .eq('id', dto.brand_id)
      .maybeSingle();

    if (errorMarca) traducirErrorPostgres(errorMarca);
    if (!marca) throw new NotFoundException('Marca no encontrada');

    const { data, error } = await this.supabase.db
      .from('products')
      .insert({
        tenant_id: marca.tenant_id,
        brand_id: marca.id,
        name: dto.name,
        price: dto.price,
        sku: dto.sku ?? null,
        min_stock: dto.min_stock ?? 3,
      })
      .select()
      .single();

    if (error) traducirErrorPostgres(error);
    return data;
  }

  async update(id: string, dto: UpdateProductDto) {
    const { data, error } = await this.supabase.db
      .from('products')
      .update(dto)
      .eq('id', id)
      .select();

    if (error) traducirErrorPostgres(error);
    // Cero filas puede significar "no existe" o "es de otra marca". Se responde
    // igual en ambos casos: confirmar la existencia de una fila ajena ya sería
    // una fuga.
    if (!data || data.length === 0) throw new NotFoundException('Producto no encontrado');
    return data[0];
  }

  async remove(id: string) {
    const { data, error } = await this.supabase.db
      .from('products')
      .delete()
      .eq('id', id)
      .select();

    if (error) traducirErrorPostgres(error);
    if (!data || data.length === 0) throw new NotFoundException('Producto no encontrado');
  }
}
