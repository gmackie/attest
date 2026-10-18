import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {Effect} from "effect";
import {assertOAuthMandateIntersection} from "../src/oauth.ts";
import {verifyPresentation} from "../src/index.ts";
import type {AgentMandate,OperationContext} from "../src/protocol.ts";

const fixture=JSON.parse(readFileSync(new URL("../fixtures/mandate-v1.json",import.meta.url),"utf8")) as {
  now:number;mandate:AgentMandate;token:string;keyId:string;issuerPublicKey:JsonWebKey;
};
const issuer="https://company-idp.example.test";
async function sample(){
  const m=fixture.mandate,at=fixture.now;
  const verified=await Effect.runPromise(verifyPresentation([fixture.token],{
    now:()=>at,maxStatusAgeMs:5000,
    resolveKey:async(source,kid)=>source===m.issuer && kid===fixture.keyId?fixture.issuerPublicKey:null,
    authorizedIssuer:async(source,subject)=>source===m.issuer && subject===m.subject,
    status:async(_ref,digest)=>({digest,status:"active",observedAt:at,validUntil:at+5000}),
  }));
  const operation:OperationContext={
    subject:m.subject,tenant:m.tenant,actor:m.delegate,audience:m.audience,
    action:"orders.exchange",resource:"order:7",purpose:"CustomerSupport",
    terms:{recipient:"alice",replacement:"medium"},
    money:{currency:"USD",amountMinor:7000},
  };
  const oauth={
    tokenType:"access-token" as const,issuer,subject:m.subject,tenant:m.tenant,
    audience:m.audience,clientId:m.delegate.clientId,
    holderKeyThumbprint:m.delegate.keyThumbprint,
    scopes:["orders:read","orders:write"],expiresAt:at+30000,
  };
  const requirement={issuer,scopes:["orders:write"]};
  return {verified,operation,oauth,requirement,at};
}
describe("OAuth and signed mandate intersection (A1)",()=>{
  it("requires the independently verified chain and the issuer-proven access-token authority",async()=>{
    const x=await sample();
    expect(()=>assertOAuthMandateIntersection(x.oauth,x.verified,x.operation,x.requirement,x.at)).not.toThrow();
  });
  it("rejects missing scope, wrong issuer, wrong represented subject, client, resource and holder key",async()=>{
    const x=await sample();
    for(const patch of [
      {issuer:"https://attacker.test"},{scopes:["orders:read"]},
      {subject:"user:bob"},{tenant:"other-company"},{audience:"https://evil.test/api"},
      {clientId:"https://evil.test/agent.json"},{holderKeyThumbprint:"A".repeat(43)},
      {expiresAt:x.at},
      {tokenType:"id-token" as "access-token"},
    ]) {
      expect(()=>assertOAuthMandateIntersection({...x.oauth,...patch},
        x.verified,x.operation,x.requirement,x.at)).toThrow();
    }
  });
  it("cannot gain any OAuth scope merely by holding a valid mandate",async()=>{
    const x=await sample();
    expect(()=>assertOAuthMandateIntersection({
      ...x.oauth,scopes:[],
    },x.verified,x.operation,x.requirement,x.at)).toThrow(/oauth_mandate_scope_denied/);
  });
  it("requires current mandate status and exact signed operation terms as independent constraints",async()=>{
    const x=await sample();
    expect(()=>assertOAuthMandateIntersection(x.oauth,x.verified,
      {...x.operation,terms:{recipient:"bob",replacement:"medium"}},x.requirement,x.at)).toThrow();
    expect(()=>assertOAuthMandateIntersection(x.oauth,x.verified,
      x.operation,x.requirement,x.verified.expiresAt)).toThrow();
  });
});
