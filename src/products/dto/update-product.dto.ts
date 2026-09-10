import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

/**
 * No incluye `brand_id` a propósito: un producto no cambia de marca. Aunque
 * alguien lo intentara, el WITH CHECK de la política de UPDATE lo rechazaría.
 */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  min_stock?: number;

  @IsOptional()
  @IsString()
  sku?: string;
}
