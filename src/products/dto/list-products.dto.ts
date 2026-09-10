import { IsBooleanString, IsOptional, IsUUID } from 'class-validator';

export class ListProductsDto {
  /** Solo tiene efecto para usuarios de tienda: una marca ya está limitada por RLS. */
  @IsOptional()
  @IsUUID('all')
  brandId?: string;

  @IsOptional()
  @IsBooleanString()
  soloActivos?: string;
}
