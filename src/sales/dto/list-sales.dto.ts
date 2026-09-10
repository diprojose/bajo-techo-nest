import { IsOptional, IsUUID } from 'class-validator';

export class ListSalesDto {
  @IsOptional()
  @IsUUID('all')
  brandId?: string;
}
