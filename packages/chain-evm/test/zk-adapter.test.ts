import { describe, expect, it } from "vitest";
import {
  BN254_SCALAR_FIELD, validateNativeZkConversion, type NativeZkConversion,
} from "../src/economy";
const token="0x2222222222222222222222222222222222222222";
const minter="0x3333333333333333333333333333333333333333";
const valid:NativeZkConversion={
  a:[1n,2n], b:[[3n,4n],[5n,6n]], c:[7n,8n],
  signals:[
    BigInt("0x1111111111111111111111111111111111111111"),
    123n, 456n, BigInt("0x4444444444444444444444444444444444444444"),
    BigInt(token),11155111n,1_000_200n,200n*10n**18n,
    1125912791875585000n,1n,987n,
  ],
};
const verify=(value:NativeZkConversion)=>validateNativeZkConversion(value,token,minter,1_000_000n);
describe("native ZK client boundary",()=>{
  it("accepts an exact, typed public proof bundle",()=>{
    expect(()=>verify(valid)).not.toThrow();
  });
  it.each([0,1,2,3,4,5,6,7,8,9,10])("rejects tampered field at index %s",index=>{
    const different=valid.signals.map((v,i)=>i===index?0n:v);
    expect(()=>verify({...valid,signals:different})).toThrow();
  });
  it("rejects field overflow, malformed length and expiration",()=>{
    expect(()=>verify({...valid,signals:[...valid.signals,1n]})).toThrow();
    expect(()=>verify({...valid,signals:[...valid.signals.slice(0,2),BN254_SCALAR_FIELD,...valid.signals.slice(3)]})).toThrow();
    const expired=valid.signals.map((v,i)=>i===6?1_000_000n:v);
    expect(()=>verify({...valid,signals:expired})).toThrow();
  });
});
