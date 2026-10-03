const TabroomScraper = require('../tabroom-scraper');

describe('TabroomScraper.scrapeEntries event discovery', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('discovers events from the current fields index', async () => {
    jest.spyOn(TabroomScraper, 'authenticatedFetch').mockResolvedValue(`
      <h2>Upcoming Invitational</h2>
      <a href="/index/tourn/fields.mhtml?tourn_id=40450&amp;event_id=400001">Open Policy</a>
      <a href="/index/tourn/fields.mhtml?tourn_id=40450&amp;event_id=400002">Novice Policy</a>
    `);

    const result = await TabroomScraper.scrapeEntries('40450');

    expect(result.tournamentName).toBe('Upcoming Invitational');
    expect(result.events).toEqual([
      expect.objectContaining({ eventId: '400001', name: 'Open Policy' }),
      expect.objectContaining({ eventId: '400002', name: 'Novice Policy' }),
    ]);
    expect(TabroomScraper.authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  test('falls back to the legacy entry index and supports event options', async () => {
    jest.spyOn(TabroomScraper, 'authenticatedFetch')
      .mockResolvedValueOnce('<h2>Upcoming Invitational</h2>')
      .mockResolvedValueOnce(`
        <h2>Upcoming Invitational</h2>
        <select name="event_id">
          <option value="">Choose</option>
          <option value="400001">Open Policy</option>
        </select>
      `);

    const result = await TabroomScraper.scrapeEntries('40450');

    expect(result.events).toEqual([
      expect.objectContaining({ eventId: '400001', name: 'Open Policy' }),
    ]);
    expect(TabroomScraper.authenticatedFetch).toHaveBeenCalledTimes(2);
  });
});
