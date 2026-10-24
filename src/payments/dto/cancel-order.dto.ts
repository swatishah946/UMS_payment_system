import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Fee waived by accounts office' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
