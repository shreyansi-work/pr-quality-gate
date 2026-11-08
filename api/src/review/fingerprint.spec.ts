import { describe, expect, it } from 'vitest';
import { currentCode, quoteStillInCode } from './fingerprint.js';

const patch = [
  '@@ -30,7 +30,7 @@ export class AuthService {',
  '   async register(dto: RegisterDto) {',
  '-    const email = dto.email.trim();',
  '+    const email = dto.email.toLowerCase().trim();',
  '     const existing = await this.usersService.findByEmail(email);',
].join('\n');

describe('currentCode', () => {
  it('keeps added and unchanged lines and drops removed lines and headers', () => {
    const code = currentCode(patch);
    expect(code).toContain('dto.email.toLowerCase().trim()');
    expect(code).toContain('findByEmail(email)');
    expect(code).not.toContain('dto.email.trim()');
    expect(code).not.toContain('@@');
  });
});

describe('quoteStillInCode', () => {
  it('is false when the flagged line was edited', () => {
    expect(quoteStillInCode(patch, 'const email = dto.email.trim();')).toBe(false);
  });
  it('is true when the flagged line is unchanged context or an added line', () => {
    expect(quoteStillInCode(patch, 'const existing = await this.usersService.findByEmail(email);')).toBe(true);
    expect(quoteStillInCode(patch, 'dto.email.toLowerCase().trim()')).toBe(true);
  });
  it('is true when there is no diff to look at', () => {
    expect(quoteStillInCode(undefined, 'anything')).toBe(true);
    expect(quoteStillInCode('', 'anything')).toBe(true);
  });
});
