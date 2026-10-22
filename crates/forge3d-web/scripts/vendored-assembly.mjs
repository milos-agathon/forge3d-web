import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from "node:fs";
import {join,dirname,posix} from "node:path";
import {createHash} from "node:crypto";
import ts from "typescript";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
export class VendoredAssembly {
  #root; #lock; #npm; #assets=new Map(); #imports=new Map();
  constructor({root,lock,npmLock}) {this.#root=root;this.#lock=lock;this.#npm=npmLock;}
  record(id) {const record=this.#lock.assets.find(a=>a.id===id);if(!record)throw Error(`Unreviewed dependency: ${id}`);return record;}
  dependency(id,{files=[],imports={},emit}={}) {
    const record=this.record(id),sourceRoot=join(this.#root,"node_modules",record.package);
    if(record.ecosystem==="npm") {
      const npm=this.#npm.packages["node_modules/"+record.package];
      const installed=JSON.parse(readFileSync(join(sourceRoot,"package.json"),"utf8"));
      if(npm?.version!==record.version||installed.version!==record.version||npm.integrity!==record.source.integrity) throw Error(`Dependency lock mismatch: ${id}`);
    }
    const source=`${record.package}@${record.version}`;
    // Read every input before copying; a missing license rejects the whole plan.
    const inputs=files.map(file=>{
      const bytes=readFileSync(join(sourceRoot,file.from));
      if(!bytes.length)throw Error(`Empty vendored input: ${file.from}`);
      const pin=record.build.artifacts.find(a=>a.name===file.from);
      if(pin&&pin.sha256!==sha(bytes))throw Error(`Upstream digest mismatch: ${file.from}`);
      return {file,bytes};
    });
    for(const {file,bytes} of inputs) this.emit(file.to,source,file.script?Buffer.from(bytes.toString("utf8").replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/u,"\n")):bytes);
    if(emit)emit((path,bytes)=>this.emit(path,source,bytes));
    for(const [specifier,path] of Object.entries(imports))this.#imports.set(specifier,path);
    return sourceRoot;
  }
  emit(path,source,bytes) {mkdirSync(dirname(join(this.#root,path)),{recursive:true});writeFileSync(join(this.#root,path),bytes);this.retain(source,[path]);}
  retain(source,paths) {for(const path of paths)this.#assets.set(path,{path,source,sha256:sha(readFileSync(join(this.#root,path)))});}
  retainDependency(id,paths) {
    const record=this.record(id);
    for(const path of paths) {
      const pin=record.build.artifacts.find(a=>a.name===path||a.name===posix.basename(path));
      if(pin&&pin.sha256!==sha(readFileSync(join(this.#root,path))))throw Error(`Upstream digest mismatch: ${path}`);
    }
    this.retain(`${record.package}@${record.version}`,paths);
  }
  rewriteImports() {
    for(const file of readdirSync(join(this.#root,"dist"))) {
      if(!file.endsWith(".js"))continue;
      const path=join(this.#root,"dist",file),text=readFileSync(path,"utf8"),edits=[];
      const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      const visit=node=>{
        const literal=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier:ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
        if(literal&&ts.isStringLiteral(literal)&&this.#imports.has(literal.text)) {
          const target=this.#imports.get(literal.text);
          if(!existsSync(join(this.#root,target)))throw Error(`Dangling vendored import: ${literal.text} -> ${target}`);
          edits.push({start:literal.getStart(ast)+1,end:literal.end-1,value:"./"+posix.relative("dist",target)});
        }
        ts.forEachChild(node,visit);
      };visit(ast);
      let output=text;for(const edit of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.value+output.slice(edit.end);
      if(output!==text)writeFileSync(path,output);
    }
  }
  finish() {
    this.rewriteImports();
    const assets=[...this.#assets.values()].sort((a,b)=>a.path.localeCompare(b.path));
    writeFileSync(join(this.#root,"dist/asset-manifest.json"),JSON.stringify({assets},null,2)+"\n");
    return assets;
  }
}
