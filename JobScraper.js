// ==UserScript==
// @name         JobScraper
// @namespace    http://tampermonkey.net/
// @version      2025-02-16
// @description  Scrape new postings from a few careers pages.
// @author       Nick Kantack
// @match        https://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @require      https://nickkantack.github.io/KantackJsCommons/dist/KJSC.js
// ==/UserScript==


/*
The general workflow of this script is to navigate a list of websites that are career pages.
Each one of these pages is referred to as a "base page."
This tool expects each base page to potentially require multiple visits to child pages, which
we'll refer to as "child pages." At least initially I expect that a child page will be a
posting for a specific position, and a base page will usually be a page showing search results
for a company's open positions.

We expect to follow this sequence:
1) Reset this script.
2) The script will iterate through a list of base pages and store the current active
   base page in a variable.
   2.1) For each base page, generate a list of child pages to visit. A few "intermediate pages"
        might need to be visited to fully scrape a base page (e.g. stepping through its
        paginated results). In this case, the base page has a few intermediate pages that
        must be visited to produce a list of child pages.
   2.2) For each child page, scrape the details needed using a scraping method that is custom
        for the base page.

---------------------------------------
Page visit philosophy
---------------------------------------
We will expect the "control tab" to remain alive constantly, and all page visits will
be orchestrated by helper tabs which recognize themselves as such, perform their function,
then self-close.

---------------------------------------
Guide to onboard new company
---------------------------------------
Typically, you only need to do two relatively simple things:
1. Find a good URL that this scraper can use to reach a base page on which a company's
   positions are listed, and
2. Write a method that runs on that page and produces a list of link URLs to specific
   job postings you are interested in.

There is not a high bar for these two steps to filter out jobs you aren't interested in
(e.g. designer jobs) because doing so at this stage is just hard (without actually
visiting job posting pages it's difficult to make that judgment).

*/

function isServerRunning() {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: "GET",
            url: `http://127.0.0.1:10152/kv/healthcheck`,
            onload: r => {
                if (r.status !== 200) {
                    reject(r);
                }
                resolve(true);
            },
            onerror: () => resolve(false)
        });
    });
}

/* key should be a string. Ithis method will return an object or throw. */
function kvGet(key) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: "GET",
            url: `http://127.0.0.1:10152/kv/${encodeURIComponent(key)}`,
            onload: r => {
                if (r.status !== 200) {
                    reject(r);
                }
                resolve(JSON.parse(r.responseText))
            },
            onerror: reject
        });
    });
}

/* key should be a string. value should be an object. */
function kvSet(key, value) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: "PUT",
            url: `http://127.0.0.1:10152/kv/${encodeURIComponent(key)}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(value),
            onload: r => resolve(JSON.parse(r.responseText)),
            onerror: reject
        });
    });
}

async function runHelperTab(url, method) {

    const timeoutMs = 10000;

    // Set waiting state
    await KJSC.IO.setValue(`HELPER_TAB_HOST`, /\/\/([^\/]+)/.exec(url)[1]);
    await KJSC.IO.setValue(`HELPER_TAB_DATA`, `waiting`);
    await KJSC.IO.setValue(`HELPER_TAB_TIMEOUT`, Date.now() + timeoutMs);
    await KJSC.IO.setValue(`HELPER_TAB_METHOD`, `(${method.toString()})()`);

    // Open page in separate tab
    const a = document.createElement(`a`);
    a.href = url;
    a.target = `_blank`;
    a.rel = `noopener noreferrer`;
    a.click();
    a.remove();

    // Schedule wait for data
    return new Promise((resolve, reject) => {
        let timeout;
        const interval = setInterval(async () => {
            KJSC.IO.getValue(`HELPER_TAB_DATA`).then(data => {
                if (data !== `waiting`) {
                    clearInterval(interval);
                    clearTimeout(timeout);
                    resolve(data);
                }
            }, 2000);
        });
        timeout = setTimeout(() => {
            clearInterval(interval);
            console.warn(`Timed out waiting for data from ${url}`);
            resolve(null);
        }, timeoutMs);
    });
}

async function checkHelperTab() {

    const isHelperTabActive = (await new RegExp(KJSC.IO.getValue(`HELPER_TAB_HOST`)).test(window.location.href)) &&
          (await KJSC.IO.getValue(`HELPER_TAB_DATA`) === `waiting`) &&
          (await KJSC.IO.getValue(`HELPER_TAB_TIMEOUT`) > Date.now());
    if (isHelperTabActive) {
        console.log(`Waiting a bit for the page to load`);
        await KJSC.WebClient.waitMs(6000);
        console.log(`Running helper tab method`);
        console.log(`Result is ${eval(await KJSC.IO.getValue(`HELPER_TAB_METHOD`))}`);
        // Only write if the main tab is still awaiting data; this helps deconflict if multiple helpers were started
        if (await KJSC.IO.getValue(`HELPER_TAB_DATA`) === `waiting`) {
            await KJSC.IO.setValue(`HELPER_TAB_DATA`, eval(await KJSC.IO.getValue(`HELPER_TAB_METHOD`)));
        }
        // Auto close the page
        window.close();
    } else {
        console.log(`Declining to run helper tab method.`);
    }

}

async function runBaseScraper(companyName, functionToGetJobObjects, functionToGetJobUrlFromObject) {

    const jobObjects = await functionToGetJobObjects();
    if (jobObjects == undefined) return;

    if (!functionToGetJobUrlFromObject) {
        functionToGetJobUrlFromObject = (j) => {
            if (!j) {
                console.warn(`Was asked to extract a job URL from a falsy job object (${j})`);
            }
            return j;
        };
    }

    // TODO in the future pass all the data to the local server instead of
    // merely logging it
    console.log(jobObjects);

}

(async function() {
    'use strict';

    if (!isServerRunning()) {
        console.warn("Job scraper server isn't running. No further work will be done.");
        alert("Job scraper server isn't running. Stopping now.");
        return;
    }

    await kvSet("test", {purpose: "test"});
    console.log(await kvGet("test"));

    return

    // Good to do this first to avoid race condition where this page might think it is a helper tab.
    checkHelperTab();

    // Use a specific domain for the control tab to help clarify control vs. helper
    // roles for a tab that is running this script.
    if (/nickkantack\.github\.io/.test(window.location.href)) {

        const scrapeButton = document.createElement(`button`);
        scrapeButton.innerHTML = `Scrape jobs`;
        document.body.appendChild(scrapeButton);
        scrapeButton.addEventListener(`click`, async () => {
            console.log(`Running scrapers`);

            await runBaseScraper(`BLOCK`, async () => {
                // Block has an endpoint we can hit to get a JSON response, so we don't need to nagivate to the base page.
                const unparsedJson = await KJSC.WebClient.loadUrlSync("https://block.xyz/api/careers/jobs?employeeTypes[]=Regular&isRemote=true&page=1&pageLimit=5000&teams[]=Machine%20Learning%2FData%20Science&teams[]=Software%20Engineering", { returnParsedHtml: false });
                const parsedJson = JSON.parse(unparsedJson);
                return parsedJson.currentPage;
            }, (jobObject) => {
                return `https://block.xyz/careers/jobs/${jobObject.id}`;
            });

            await runBaseScraper(`CONFLUENT`, async() => {
                // Confluent requires visiting the website.
                let jobObjects = [];
                for (let i = 1; i <= 4; i++) {
                    const newJobObjects = await runHelperTab(`https://careers.confluent.io/search/engineering/jobs/in/country/united-states?page=${i}#`, () => {
                        return [...document.querySelectorAll(`a`)].map(a => a.href).filter(url => /https:\/\/careers\.confluent\.io\/jobs\/[0-9]+/.test(url));
                    });
                    if (!newJobObjects) return [];
                    jobObjects = jobObjects.concat(newJobObjects);
                }
                return jobObjects;
            }, (jobObject) => {
                // We just decided to make jobObject the url of a job posting, so we don't need to alter it.
                return jobObject;
            });

            await runBaseScraper(`MOZILLA`, async() => {
                return await runHelperTab(`https://www.mozilla.org/en-US/careers/listings/?location=Remote%20US`, () => {
                    return [...document.querySelectorAll(`#listings-positions tr.position a`)].map(a => a.href).filter(url => /\/careers\/position\//.test(url));
                });
            }, (jobObject) => {
                // We decided that jobObject should be the url of a job posting
                return jobObject;
            });

            await runBaseScraper(`ATLASSIAN`, async() => {
                return await runHelperTab(`https://www.atlassian.com/company/careers/all-jobs?team=Engineering%2CAnalytics%20%26%20Data%20Science&location=United%20States&search=`, () => {
                    return [...document.querySelectorAll(`div.careers td a`)].map(a => a.href).filter(url => /\/company\/careers\//.test(url));
                });
            }, (jobObject) => {
                return jobObject;
            });

            await runBaseScraper(`DATADOG`, async() => {
                return await runHelperTab(`https://careers.datadoghq.com/all-jobs/?location_Americas%5B0%5D=Remote`, () => {
                    return [...document.querySelectorAll(`#hits a`)].map(a => a.href).filter(url => /\/detail\//.test(url));
                });
            });

            await runBaseScraper(`ATTENTIVE`, async() => {
                return await runHelperTab(`https://www.attentive.com/careers#jobs`, () => {
                    return [...document.querySelectorAll(`ul.lever-team[data-team="Engineering"] a.lever-job-title`)].map(a => a.href).filter(url => /\/attentive\//.test(url));
                });
            });

            await runBaseScraper(`AUTODESK`, async() => {
                return await runHelperTab(`https://autodesk.wd1.myworkdayjobs.com/Ext?locationCountry=bc33aa3152ec42d4995f4791a106ed09&workerSubType=f116d80c3e014c758115c336e67d241e&jobFamilyGroup=1f75c4299c9201c0f3b5f8e6fa01c5bf&jobFamilyGroup=1f75c4299c9201e81c554be7fa01d1bf&timeType=6d5ece62cf5a4f9f9e349b55f045b5e2&locations=33c9184ffc6401eaa6e2e84a63015d42&locations=33c9184ffc640153e7a5dc4a63015342&locations=33c9184ffc64010b7e98d04a63014942&locations=33c9184ffc6401d850e7a34a63013042&locations=33c9184ffc6401cb3df82e4a63010342&locations=33c9184ffc6401954e15424a63010842&locations=33c9184ffc64019df45ce4496301db41&locations=33c9184ffc640177cf70de496301d641&locations=33c9184ffc6401f15d9ed2496301cc41&locations=50929ce007694527a1954f6fb4fbdec4&locations=4365f10aa7884d22bd7b753b1c9eaab3&locations=884ca74dc09643448573945e9ed3cc88&locations=01ba61f9692f44daaf4ce8b08254179c&locations=870e95ce55ce4911bda6a619b9fa1557&locations=e3425e5435884bb1a276ca06a0f007ac&locations=9a608d58274a4842bd0f593ed8066602&locations=2ce26139f17a4e318ce3d59d54625cea&locations=ca17354534a2408c8e3e65d7f91f3f5e&locations=ba89314678ad4e00bea68e6e33203233&locations=74cd081bb7eb4888b965620919b4a3c0&locations=73b490026f5e476eb10173c1467469ce`, () => {
                    return [...document.querySelectorAll(`a[data-automation-id="jobTitle"]`)].map(a => a.href).filter(url => /\/job\//.test(url));
                });
            });

            await runBaseScraper(`PAXOS`, async() => {
                return await runHelperTab(`https://www.paxos.com/jobs`, () => {
                    return [...document.querySelectorAll(`div.job-listings a`)].map(a => a.href).filter(url => /\/jobs\//.test(url));
                });
            });

            await runBaseScraper(`HERTZ`, async() => {
                return await runHelperTab(`https://jobs.hertzcareers.com/#en/sites/CX_1/requisitions?lastSelectedFacet=LOCATIONS&mode=location&selectedFlexFieldsFacets=%22AttributeChar2%7CRemote%22&selectedLocationsFacet=300000000480126&selectedPostingDatesFacet=30`, () => {
                    return [...document.querySelectorAll(`a.job-list-item__link`)].map(a => a.href).filter(x => x);
                });
            });

            await runBaseScraper(`NEW-RELIC`, async() => {
                return await runHelperTab(`https://newrelic.com/careers?areaOfInterest=Data%2520Analytics%7CEngineering&workArrangement=Remote`, () => {
                    return [...document.querySelectorAll(`a.job-title`)].map(a => a.href);
                });
            });

            await runBaseScraper(`MIXPANEL`, async() => {
                return await runHelperTab(`https://mixpanel.com/jobs/`, () => {
                    return [...document.querySelectorAll(`a.Link`)].filter(a => /ats\.comparably/.test(a.href) &&
                                                                            [...a.parentNode.parentNode.querySelectorAll(`span`)].some(x => /remote/i.test(x.innerHTML)))
                                                                    .map(a => a.href);
                });
            });

            await runBaseScraper(`ZOOM`, async() => {
                return await runHelperTab(`https://careers.zoom.us/jobs/search?page=1&category_uids%5B%5D=b79264f5877fa58df2bb612887751822&category_uids%5B%5D=8d5fb973de9f83d0b046212bdb459dbb&country_codes%5B%5D=US&cities%5B%5D=Remote&query=`, () => {
                    return [...document.querySelectorAll(`a[id^="link_job_title"]`)].map(a => a.href);
                });
            });

            await runBaseScraper(`CROWDSTRIKE`, async() => {
                return await runHelperTab(`https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers?locationCountry=bc33aa3152ec42d4995f4791a106ed09&locations=20feac86ebdd0102586dc95b42138d6f&Job_Family=1408861ee6e201641be2c2f6b000c00b&Job_Family=cb19f044639b1001f6a02595bc920000`, () => {
                    return [...document.querySelectorAll(`a[data-automation-id="jobTitle"]`)].map(a => a.href);
                });
            });

            await runBaseScraper(`MOTIONAL`, async() => {
                return await runHelperTab(`https://motional.com/open-positions#/?employmentType=Full-time&location=4060369003`, () => {
                    return [...document.querySelectorAll(`h2.job__title a`)].map(a => a.href);
                });
            });

            await runBaseScraper(`FANATICS`, async() => {
                return await runHelperTab(`https://fa-exki-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions?keyword=Engineer&lastSelectedFacet=WORKPLACE_TYPES&mode=location&selectedLocationsFacet=300000000466546&selectedWorkplaceTypesFacet=ORA_REMOTE`, () => {
                    return [...document.querySelectorAll(`a.job-list-item__link`)].map(a => a.href);
                });
            });

            await runBaseScraper(`NERDWALLET`, async() => {
                return await runHelperTab(`https://www.nerdwallet.com/careers/engineering`, () => {
                    return [...document.querySelectorAll(`div.joblistTileInner`)].filter(x => [...x.querySelectorAll(`span`)].some(y => /remote/i.test(y.innerHTML))).map(x => x.closest(`a`).href);
                });
            });

            await runBaseScraper(`MARQETA`, async() => {
                return await runHelperTab(`https://www.marqeta.com/company/careers/all-jobs`, () => {
                    return [...document.querySelectorAll(`td`)].filter(x => /remote/i.test(x.innerHTML) && /USA/i.test(x.innerHTML)).map(x => x.closest("a").href);
                });
            });
        });
    }

})();