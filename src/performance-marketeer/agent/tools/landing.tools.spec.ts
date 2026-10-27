import { ownUrl, parseLanding } from './landing.tools';

describe('landing page tools', () => {
  it('only accepts our own https site and strips tracking params', () => {
    expect(ownUrl('https://91astrology.com/golu-devta-arzi?utm_source=fb&fbclid=x')).toBe(
      'https://91astrology.com/golu-devta-arzi',
    );
    expect(ownUrl('https://www.91astrology.com/hi/nadi-report')).toBe(
      'https://www.91astrology.com/hi/nadi-report',
    );
    expect(ownUrl('https://evil.com/91astrology.com')).toBeNull();
    expect(ownUrl('http://91astrology.com/x')).toBeNull();
    expect(ownUrl('not a url')).toBeNull();
  });

  it('reads title, headings, prices, buttons and text without scripts', () => {
    const p = parseLanding(
      `<html><head><title>Golu Devta Wish | 91Astrology</title>
       <meta name="description" content="Your wish &amp; a photo"></head>
       <body><script>var x = "₹9999";</script>
       <h1>A wish, carried to <span>Chitai</span></h1>
       <p>₹1100 <s>₹2,999</s> Save 63%</p>
       <button type="button">Submit my wish</button>
       <img src="a.jpg" alt="The sacred gate">
       <h2>FAQ</h2><p>When is it tied?</p></body></html>`,
    );
    expect(p.title).toBe('Golu Devta Wish | 91Astrology');
    expect(p.description).toBe('Your wish & a photo');
    expect(p.headings.h1).toEqual(['A wish, carried to Chitai']);
    expect(p.prices).toEqual(['₹1100', '₹2,999']);
    expect(p.buttons).toContain('Submit my wish');
    expect(p.images).toEqual(['The sacred gate']);
    expect(p.text).toContain('When is it tied?');
    expect(p.text).not.toContain('9999');
  });
});
