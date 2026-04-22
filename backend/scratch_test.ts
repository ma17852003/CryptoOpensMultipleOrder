import ccxt from 'ccxt';

const exchange = new ccxt.mexc({
    options: { defaultType: 'swap' }
});

async function run() {
    try {
        await exchange.loadMarkets();
        const btcMarket = exchange.market('BTC/USDT:USDT');
        console.log('BTC market info:', JSON.stringify({
            contractSize: btcMarket.contractSize,
            precision: btcMarket.precision,
            limits: btcMarket.limits
        }, null, 2));
    } catch (e) {
        console.error('Error:', e);
    }
}
run();
