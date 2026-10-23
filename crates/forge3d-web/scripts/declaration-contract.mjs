import {readFileSync,writeFileSync,readdirSync,existsSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import ts from "typescript";

// These reviewed declarations predate generated feature declarations. In
// particular, index.d.ts remains an independent, snapshot-reviewed contract.
const reviewed=new Set(["index","postfx","postfx-types","probe-bake-options","scatter-mesh","scatter-random","scatter-source","terrain-probes","terrain-scatter","vector-picking"]);
const facadeModules=new Set(["frames","scene","camera","range-scheduler","byte-cache","renderer-config","runtime-failure"]);
const normalizeNewlines=text=>text.replace(/\r\n/g,"\n");
export function publishDeclarationGraph(root) {
 const types=join(root,"types"),dist=join(root,"dist"),visited=new Set(),outputs=new Map();
 function visit(name) {
  if(visited.has(name))return;visited.add(name);
  const file=join(types,name+".d.ts");
  let text=readFileSync(reviewed.has(name)?file:join(dist,name+".d.ts"),"utf8");
  if(!reviewed.has(name))text=text.replace(/(["'])\.\/([a-z0-9_-]+)\.js\1/g,(whole,quote,module)=>facadeModules.has(module)?quote+"./index.js"+quote:whole);
  for(const {fileName} of ts.preProcessFile(text,true,true).importedFiles) {
   if(!fileName.startsWith("."))continue;
   const dependency=resolve(dirname(file),fileName.replace(/\.js$/,".d.ts"));
   if(dirname(dependency)!==resolve(types))throw Error(`Declaration dependency escapes published graph: ${fileName}`);
   visit(basename(dependency,".d.ts"));
  }
  if(!reviewed.has(name))outputs.set(file,text);
 }
 // Existing shipped declaration modules are roots too: preserve direct type
 // consumers, and recursively publish newly introduced private dependencies.
 for(const file of readdirSync(types).filter(f=>f.endsWith(".d.ts")))visit(file.slice(0,-5));
 for(const [file,text]of outputs) {
  // Preserve unchanged checkout bytes and metadata: rewriting CRLF as LF can
  // make Windows Git status dirty even when its tracked content diff is empty.
  if(existsSync(file)&&normalizeNewlines(readFileSync(file,"utf8"))===normalizeNewlines(text))continue;
  writeFileSync(file,text);
 }
 return [...visited].sort();
}
const normalize=text=>normalizeNewlines(text).trimEnd();
export function verifyDeclarationContract({root,emittedExports,facade=join(root,"types/index.d.ts"),snapshot=join(root,"tests/api/index.d.ts.snapshot"),consumerConfig=join(root,"tsconfig.api.json")}) {
 if(normalize(readFileSync(facade,"utf8"))!==normalize(readFileSync(snapshot,"utf8")))throw Error("Reviewed declaration facade differs from its snapshot");
 const config=ts.readConfigFile(consumerConfig,ts.sys.readFile);
 if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,"\n"));
 const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,dirname(consumerConfig));
 const program=ts.createProgram([...new Set([...parsed.fileNames,facade])],{...parsed.options,noEmit:true,skipLibCheck:false});
 const diagnostics=[...parsed.errors,...ts.getPreEmitDiagnostics(program)];
 if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>root,getNewLine:()=>"\n"}));
 const checker=program.getTypeChecker(),source=program.getSourceFile(facade),symbol=checker.getSymbolAtLocation(source);
 function runtimeNames(file, seen=new Set()) {
  if(seen.has(file.fileName))return new Set();seen.add(file.fileName);
  const names=new Set();
  for(const node of file.statements) {
   if(ts.isExportDeclaration(node)) {
    if(node.isTypeOnly)continue;
    if(node.exportClause && ts.isNamedExports(node.exportClause)) {
     for(const item of node.exportClause.elements)if(!item.isTypeOnly)names.add(item.name.text);
    } else if(node.exportClause && ts.isNamespaceExport(node.exportClause)) names.add(node.exportClause.name.text);
    else if(node.moduleSpecifier) {
     const dependency=checker.getSymbolAtLocation(node.moduleSpecifier)?.declarations?.find(ts.isSourceFile);
     if(dependency)for(const name of runtimeNames(dependency,seen))names.add(name);
    }
   } else if(ts.getCombinedModifierFlags(node)&ts.ModifierFlags.Export) {
    if(ts.isVariableStatement(node)) {for(const item of node.declarationList.declarations)if(ts.isIdentifier(item.name))names.add(item.name.text);}
    else if(node.name&&ts.isIdentifier(node.name))names.add(node.name.text);
   }
  }
  return names;
 }
 const names=runtimeNames(source);
 const values=checker.getExportsOfModule(symbol).filter(symbol=>{
   if(!names.has(symbol.name))return false;
   const target=symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
   return !!(target.flags&ts.SymbolFlags.Value);
 }).map(s=>s.name).sort();
 if(emittedExports) {
  const actual=[...emittedExports].sort(),missing=values.filter(n=>!actual.includes(n)),extra=actual.filter(n=>!values.includes(n));
  if(missing.length||extra.length)throw Error(`Runtime/declaration exports differ; missing: ${missing.join(", ")}; undeclared: ${extra.join(", ")}`);
 }
 return {valueExports:values,consumerFiles:parsed.fileNames};
}
