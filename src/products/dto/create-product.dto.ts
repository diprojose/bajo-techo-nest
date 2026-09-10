import { IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  // IsUUID('all'): el tipo uuid de Postgres acepta cualquier versión, así que
  // exigir v4 rechazaría identificadores perfectamente válidos.
  @IsUUID('all')
  brand_id!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  /** COP, entero. */
  @IsInt()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  min_stock?: number;
}
