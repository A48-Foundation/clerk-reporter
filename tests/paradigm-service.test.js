const ParadigmService = require('../paradigm-service');

describe('ParadigmService.fetchParadigmByName', () => {
  test('removes trailing inline pronouns before searching Tabroom', async () => {
    const service = new ParadigmService();
    service.searchJudge = jest.fn().mockResolvedValue([]);

    await service.fetchParadigmByName('Hunter Harwood (He/Him)');

    expect(service.searchJudge).toHaveBeenCalledWith('Hunter', 'Harwood');
  });

  test('preserves non-pronoun parenthetical text', async () => {
    const service = new ParadigmService();
    service.searchJudge = jest.fn().mockResolvedValue([]);

    await service.fetchParadigmByName('John Smith (Judge)');

    expect(service.searchJudge).toHaveBeenCalledWith('John', 'Smith (Judge)');
  });
});
