const TabroomScraper = require('../tabroom-scraper');

describe('TabroomScraper.findJudgesUrl', () => {
  test('selects the Policy/CX judges category instead of another event', async () => {
    const fetchPage = jest.spyOn(TabroomScraper, 'authenticatedFetch').mockResolvedValue(`
      <ul>
        <li>Lincoln Douglas <a href="/index/tourn/judges.mhtml?category_id=10&tourn_id=99">Judges</a></li>
        <li>Policy Debate <a href="/index/tourn/judges.mhtml?category_id=20&tourn_id=99">Judges</a></li>
      </ul>
    `);

    const url = await TabroomScraper.findJudgesUrl('99', '123');

    expect(url).toContain('category_id=20');
    fetchPage.mockRestore();
  });

  test('does not guess when multiple non-policy judge pools are present', async () => {
    const fetchPage = jest.spyOn(TabroomScraper, 'authenticatedFetch').mockResolvedValue(`
      <ul>
        <li>Lincoln Douglas <a href="/index/tourn/judges.mhtml?category_id=10&tourn_id=99">Judges</a></li>
        <li>Public Forum <a href="/index/tourn/judges.mhtml?category_id=30&tourn_id=99">Judges</a></li>
      </ul>
    `);

    const url = await TabroomScraper.findJudgesUrl('99', '123');

    expect(url).toBeNull();
    fetchPage.mockRestore();
  });

  test('resolves Policy from the generic judges-page category selector', async () => {
    const fetchPage = jest.spyOn(TabroomScraper, 'authenticatedFetch')
      .mockResolvedValueOnce(`
        <a href="/index/tourn/judges.mhtml?tourn_id=99">Judges</a>
      `)
      .mockResolvedValueOnce(`
        <select name="category_id">
          <option value="10">Lincoln Douglas</option>
          <option value="20">Policy Debate</option>
        </select>
      `);

    const url = await TabroomScraper.findJudgesUrl('99', '123');

    expect(url).toContain('category_id=20');
    fetchPage.mockRestore();
  });

  test('recognizes CX from ancestor text around an unlabeled List link', async () => {
    const fetchPage = jest.spyOn(TabroomScraper, 'authenticatedFetch').mockResolvedValue(`
      <div><div>LD <span><a href="/index/tourn/judges.mhtml?category_id=10&tourn_id=99">List</a></span></div></div>
      <div><div>CX <span><a href="/index/tourn/judges.mhtml?category_id=20&tourn_id=99">List</a></span></div></div>
    `);

    const url = await TabroomScraper.findJudgesUrl('99', '123');

    expect(url).toContain('category_id=20');
    fetchPage.mockRestore();
  });
});
