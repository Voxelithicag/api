/* GET /api/v1/venues — площадки, которые роутер умеет исполнять.

   Вид площадки взят пробой контракта, а не ярлыком индексатора: Alandale
   приходит без метки версии и отвечает на getReserves как пул постоянного
   произведения, хотя на деле это Algebra и цена лежит в globalState. */
const { DATA, handler } = require("./_lib");

module.exports = handler(
  async () => {
    const venues = Object.values(DATA.venues);
    return {
      chainId: DATA.chainId,
      count: venues.length,
      executable: venues.filter((v) => v.executable).length,
      venues,
    };
  },
  { cacheSeconds: 3600 }
);
