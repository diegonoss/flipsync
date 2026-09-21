import { testHasher } from "./hasher.test.js";
import { testWatcher } from "./watcher.test.js";
import { testServer } from "./server.test.js";
import { testEndToEnd } from "./e2e.test.js";
import { testStandaloneClients } from "./standalone.test.js";
import { testSyncEngine, testHeadlessCli } from "./engine.test.js";
import { testCliExecution } from "./cli.test.js";
import { testCommandModal } from "./commandModal.test.js";
import { testTunnel } from "./tunnel.test.js";

async function runAll(): Promise<void> {
    const divider = "=".repeat(64);
    console.log(`\n${divider}`);
    console.log("       FlipSync -- Test Suite");
    console.log(`${divider}\n`);

    const start = Date.now();

    try {
        await testHasher();
        await testWatcher();
        await testServer();
        await testEndToEnd();
        await testStandaloneClients();
        await testSyncEngine();
        await testHeadlessCli();
        await testCliExecution();
        await testCommandModal();
        await testTunnel();

        const duration = Date.now() - start;
        console.log(`\n${divider}`);
        console.log(`  [ALL TESTS PASSED] Completed in ${duration}ms.`);
        console.log(`${divider}\n`);
    } catch (err: unknown) {
        console.error("\n[TEST FAILED]:", err);
        process.exit(1);
    }
}

runAll();
