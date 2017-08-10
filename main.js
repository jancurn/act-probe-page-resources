const chromeLauncher = require('chrome-launcher');
const CDP = require('chrome-remote-interface');
const _ = require('underscore');
const Apify = require('apify');
const typeCheck = require('type-check').typeCheck;


// Definition of the input
const INPUT_TYPE = `{
    urls: [String],
    waitSecs: Maybe Number
}`;


Apify.main(async () => {
    // Fetch and check the input
    const input = await Apify.getValue('INPUT');
    if (!typeCheck(INPUT_TYPE, input)) {
        console.log('Expected input:');
        console.log(INPUT_TYPE);
        console.log('Received input:');
        console.dir(input);
        throw new Error('Received invalid input');
    }

    // Launch Chrome
    const chrome = await launchChrome({ headless: !!process.APIFY_HEADLESS });
    const client = await CDP();

    let currentResult = null;

    // Extract domains
    const { Network, Page } = client;

    // Setup event handlers
    Network.requestWillBeSent((params) => {
        //console.log("### Network.requestWillBeSent");
        //console.dir(params);

        let req = currentResult.requests[params.requestId];
        if (!req) {
            req = currentResult.requests[params.requestId] = {};
            req.url = params.request.url;
            req.method = params.request.method;
            req.requestedAt = new Date(params.wallTime * 1000);
        } else {
            // On redirects, the Network.requestWillBeSent() is fired multiple times
            // with the same requestId and the subsequent requests contain the 'redirectResponse' field
            req.redirects = req.redirects || [];
            const redirect = _.pick(params.redirectResponse, 'url', 'status');
            redirect.location = params.redirectResponse && params.redirectResponse.headers ? params.redirectResponse.headers['location'] : null;
            req.redirects.push(redirect);
        }
    });

    Network.responseReceived((params) => {
        //console.log("### Network.responseReceived");
        //console.dir(params);

        const req = currentResult.requests[params.requestId];
        req.loadedUrl = params.response.url;
        req.status = params.response.status;
        req.mimeType = params.response.mimeType;
        req.type = params.type;
        req.loadedAt = new Date(params.wallTime * 1000);
    });

    Network.loadingFailed((params) => {
        //console.log("### Network.loadingFailed");
        //console.dir(params);

        // Note that request failures might come from the previous page
        const req = currentResult.requests[params.requestId];
        if (req) {
            req.type = params.type;
            req.errorText = params.errorText;
            req.canceled = params.canceled;
        }
    });

    // Enable events
    await Promise.all([Network.enable(), Page.enable()]);

    // Disable cache
    await Network.setCacheDisabled({ cacheDisabled: true });

    // Iterate and probe all URLs
    const results = [];
    for (let url of input.urls) {
        currentResult = {
            url,
            requests: {}
        };
        results.push(currentResult);

        await Page.navigate({ url });
        await Page.loadEventFired();
        // Wait input.waitSecs seconds
        await new Promise((resolve) => setTimeout(resolve, input.waitSecs*1000 || 0));
        await Page.stopLoading();
    }

    // Save results
    await Apify.setValue('OUTPUT', results);

    // Only useful for local development
    await chrome.kill();
});


// Code inspired by https://developers.google.com/web/updates/2017/04/headless-chrome
const launchChrome = async (options = {}) => {
    return await chromeLauncher.launch({
        port: 9222,
        chromeFlags: [
            options.headless ? '--disable-gpu' : '',
            options.headless ? '--headless' : ''
        ]
    });
};
