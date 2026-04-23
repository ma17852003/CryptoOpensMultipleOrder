const ccxt = require('ccxt');

async function test() {
    const exchange = new ccxt.mexc();
    // Check if set_trading_stop or similar exists
    console.log('has setTradingStop:', exchange.has['setTradingStop']);
    console.log('has createStopOrder:', exchange.has['createStopOrder']);
    console.log('has editOrder:', exchange.has['editOrder']);
}
test();
