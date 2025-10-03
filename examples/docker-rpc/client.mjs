import {
  basicConfig,
  LogLevel,
  RpcProxy,
  withFabric
} from "naylence-runtime";


const sentinelAddress = process.env.RPC_TARGET_ADDRESS || "calculator@/test-sentinel";

basicConfig({ level: LogLevel.INFO });


async function main() {

  await withFabric(async (fabric) => {

    await fabric.sendMessage("__sys__@/test-sentinel", "ping");

    const calculator = RpcProxy.remoteByAddress(sentinelAddress);

    console.log(await calculator.add({ a: 3, b: 4 }));
    console.log(await calculator.multiply({ a: 6, b: 7 }));

    const stream = await calculator.fib_stream({ _stream: true, n: 10 });
    const fibNumbers = [];
    for await (const value of stream) {
      fibNumbers.push(value);
    }
    console.log(fibNumbers.join(", "));
  });
}

try { await main(); }
catch (e) { console.error("RPC failed:", e); process.exitCode = 1; }
