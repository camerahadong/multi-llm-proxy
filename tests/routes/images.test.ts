import { describe, expect, it } from 'vitest';
import { buildImageUpstreamOptions } from '../../src/routes/images.js';

describe('image proxy upstream contract', () => {
  it('maps public promptMode to ima2-gen mode without keeping the wrong field name', () => {
    const options = buildImageUpstreamOptions(
      'high',
      '1024x1824',
      'oauth',
      'direct',
      'gpt-5.6-terra',
    );

    expect(options).toEqual({
      quality: 'high',
      size: '1024x1824',
      provider: 'oauth',
      mode: 'direct',
      model: 'gpt-5.6-terra',
    });
    expect(options).not.toHaveProperty('promptMode');
  });
});
