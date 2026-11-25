import { loadVerdict } from './page-load';

it("grades main-content time on Google's bands", () => {
  expect(loadVerdict(2400)).toBe('good');
  expect(loadVerdict(3004)).toBe('needs work');
  expect(loadVerdict(4500)).toBe('slow');
  expect(loadVerdict(null)).toBe('unknown');
});
