import { BadRequestException, Injectable, NotFoundException, type PipeTransform } from '@nestjs/common';

/** A database id from the URL. A huge number is "not found", not a 500 from the database. */
@Injectable()
export class IdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^\d{1,15}$/.test(value)) throw new BadRequestException('id must be a number');
    const n = Number(value);
    if (n < 1 || n > 2_147_483_647) throw new NotFoundException('Not found');
    return n;
  }
}
