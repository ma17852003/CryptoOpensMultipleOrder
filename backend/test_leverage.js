const ccxt = require('ccxt');

async function test() {
    const exchange = new ccxt.mexc();
    try {
        const markets = await exchange.loadMarkets();
        // Check a few symbols
        const symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SUI/USDT:USDT'];
        for (const symbol of symbols) {
            const market = markets[symbol];
            console.log(`--- ${symbol} ---`);
            // console.log(JSON.stringify(market, null, 2));
            console.log('Limits:', market.limits);
            console.log('Info limits:', market.info.maxLeverage); // Some exchanges have it in info
        }
    } catch (e) {
        console.error(e);
    }
}
test();
