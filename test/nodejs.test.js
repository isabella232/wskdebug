/**
 * ADOBE CONFIDENTIAL
 * ___________________
 *
 *  Copyright 2019 Adobe
 *  All Rights Reserved.
 *
 * NOTICE:  All information contained herein is, and remains
 * the property of Adobe and its suppliers, if any. The intellectual
 * and technical concepts contained herein are proprietary to Adobe
 * and its suppliers and are protected by all applicable intellectual
 * property laws, including trade secret and copyright laws.
 * Dissemination of this information or reproduction of this material
 * is strictly forbidden unless prior written permission is obtained
 * from Adobe.
 */

/* eslint-env mocha */
/* eslint mocha/no-mocha-arrows: "off" */

'use strict';

// tests for node.js debugging

// here is how most tests are setup:
// - requests to openwhisk and the agent are mocked using nock
// - docker is required and the containers actually run

const wskdebug = require('../index');
const Debugger = require("../src/debugger");

const test = require('./test');
const getPort = require('get-port');
const assert = require('assert');
const stripAnsi = require('strip-ansi');
const fs = require('fs');

describe('node.js', () => {
    before(() => {
        test.isDockerInstalled();
    });

    beforeEach(async () => {
        test.beforeEach();
        this.cwd = process.cwd();
        // find free port
        this.port = await getPort(9229);
        console.log("[test] free port:", this.port);
    });

    afterEach(() => {
        test.afterEach();
        console.log("chdir back to", this.cwd);
        process.chdir(this.cwd);
    });

    it("should print help", async () => {
        test.startCaptureStdout();

        await wskdebug(`-h`);

        const stdio = test.endCaptureStdout();

        assert.equal(stdio.stderr, "");
        // testing a couple strings that should rarely change
        assert(stdio.stdout.includes("Debug an OpenWhisk <action> by forwarding its activations to a local docker container"));
        assert(stdio.stdout.includes("Supported kinds:"));
        assert(stdio.stdout.includes("Arguments:"));
        assert(stdio.stdout.includes("Action options:"));
        assert(stdio.stdout.includes("LiveReload options:"));
        assert(stdio.stdout.includes("Debugger options:"));
        assert(stdio.stdout.includes("Agent options:"));
        assert(stdio.stdout.includes("Options:"));
    });

    it("should print the version", async () => {
        test.startCaptureStdout();

        await wskdebug(`--version`);

        const stdio = test.endCaptureStdout();
        assert.equal(stdio.stderr, "");
        assert.equal(stripAnsi(stdio.stdout.trim()), require(`${process.cwd()}/package.json`).version);
    });

    it("should run an action without local sources", async () => {
        test.mockActionAndInvocation(
            "myaction",
            `function main(params) {
                return {
                    msg: 'CORRECT',
                    input: params.input
                }
            }`,
            { input: "test-input" },
            { msg: "CORRECT", input: "test-input" }
        );

        await wskdebug(`myaction -p ${this.port}`);

        test.assertAllNocksInvoked();
    })
    .timeout(20000);

    it("should mount local sources with plain js and flat source structure", async () => {
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        process.chdir("test/plain-flat");
        await wskdebug(`myaction action.js -p ${this.port}`);

        test.assertAllNocksInvoked();
    })
    .timeout(20000);

    it("should mount local sources with plain js and one level deep source structure", async () => {
        test.mockActionAndInvocation(
            "myaction",
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        process.chdir("test/plain-onelevel");
        await wskdebug(`myaction lib/action.js -p ${this.port}`);

        test.assertAllNocksInvoked();
    })
    .timeout(20000);

    it.skip("should mount and run local sources with a comment on the last line", async () => {
        test.mockActionAndInvocation(
            "myaction",
            `const main = () => ({ msg: 'WRONG' });`,
            { },
            { msg: "CORRECT" }
        );

        process.chdir("test/trailing-comment");
        await wskdebug(`myaction -p ${this.port} action.js`);

        test.assertAllNocksInvoked();
    })
    .timeout(20000);

    it("should mount local sources with commonjs and flat source structure", async () => {
        test.mockActionAndInvocation(
            "myaction",
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "one/two" },
            true // binary = true for nodejs means zip action with commonjs (require) loading
        );

        process.chdir("test/commonjs-flat");
        await wskdebug(`myaction action.js -p ${this.port}`);

        test.assertAllNocksInvoked();
    })
    .timeout(20000);

    it("should invoke action when a source file changes and -P is set", async () => {
        const action = "myaction";
        const code = `const main = () => ({ msg: 'WRONG' });`;

        test.mockAction(action, code);
        test.expectAgent(action, code);

        // mock agent & action invocaton logic on the openwhisk side
        const ACTIVATION_ID = "1234567890";
        let invokedAction = false;
        let completedAction = false;

        test.nockActivation("myaction")
            .reply(async (uri, body) => {
                let response = [];
                // wskdebug polling the agent
                if (body.$waitForActivation === true) {
                    // when the action got invoked, we tell it wskdebug
                    // but only once
                    if (invokedAction && !completedAction) {
                        response = [ 200, {
                            response: {
                                result: {
                                    $activationId: ACTIVATION_ID
                                }
                            }
                        }];
                    } else {
                        // tell wskdebug to retry polling
                        response = [ 502, test.agentRetryResponse() ];
                    }
                } else if (body.key === "invocationOnSourceModification") {
                    // the action got invoked
                    invokedAction = true;
                    response = [ 200, { activationId: ACTIVATION_ID } ];

                } else if (body.$activationId === ACTIVATION_ID) {
                    // action was completed by wskdebug
                    completedAction = true;
                    response = [ 200, {}];
                }
                return response;
            })
            .persist();

        // wskdebug myaction action.js -l -p ${this.port}
        process.chdir("test/plain-flat");
        const argv = {
            verbose: true,
            port: this.port,
            action: "myaction",
            sourcePath: `${process.cwd()}/action.js`,
            invokeParams: '{ "key": "invocationOnSourceModification" }'
        };

        const dbgr = new Debugger(argv);
        await dbgr.start();
        dbgr.run();

        // simulate a source file change
        fs.utimesSync("action.js", Date.now(), Date.now());

        // eslint-disable-next-line no-unmodified-loop-condition
        while (!completedAction) {
            await test.sleep(100);
        }

        await dbgr.stop();

        assert.ok(invokedAction, "action was not invoked on source change");
        assert.ok(completedAction, "action invocation was not handled and completed");
        test.assertAllNocksInvoked();
    })
    .timeout(20000);

    // TODO: test -P action invocation (and -a)
    // TODO: check lr port => separate test
    //livereload: true,

    // TODO: test --on-build and --build-path
    // TODO: test agents - conditions (unit test agent code locally)
    // TODO: test ngrok (?)
    // TODO: test breakpoint debugging
    // TODO: test -l livereload
    // TODO: test -r shell command
    // TODO: test action options
    // TODO: test debugger options
    // TODO: test --on-start

});