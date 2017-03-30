
import {Tag,Reader} from "./reader";
import * as fs from "fs";
import * as path from "path";


export class Includer
{
	included:Object = {};
	including:Object = {};
	list:string[] = [];
	errors:Array<[string, number, string]> = [];
	
	include(src:string|string[]):void
	{
		if (src instanceof Array)
		{
			for (var i=0;i<src.length;i++)
			{
				this.include(src[i]);
			}
			return;
		}
		if (src in this.included)
			return;
		if (src in this.including)
			throw Error("SELF_INCLUDE");
		this.included[src] = true;
		this.including[src] = true;

		try
		{
			var data:string = fs.readFileSync(src, "utf8");
		}
		catch(e)
		{
			throw Error("FILE_NOT_FOUND");
		}
		const arr:Tag[] = readXml(data);

		var dir = src.substr(0, src.lastIndexOf("/")+ 1);
		for (const tag of arr)
		{
			switch (tag.name)
			{
			case "reference":
				var file = path.normalize(dir + tag.props.path).replace(/\\/g, "/");
				try
				{
					this.include(file);
				}
				catch(e)
				{
					switch(e.message)
					{
					case "SELF_INCLUDE":
						this.errors.push([src, tag.lineNumber, e.message]);
						break;
					case "FILE_NOT_FOUND":
						this.errors.push([src, tag.lineNumber, "File not found: "+path.resolve(file)]);
						break;
					default: throw e;
					}
				}
				break;
			}
		}
		this.list.push(src);
	}

}

export function readXml(data:string):Tag[]
{
	const page = new Reader;
	page.data = data;

	var lineNumber = 0;
	const line = new Reader;
	const out:Tag[] = [];

	for(;;)
	{
		page.skipSpace();
		if (!page.startsWith("///")) break;
		
		lineNumber++;
		line.i = 0;
		var linestr = page.readTo("\n");;
		if (!linestr) continue;
	
		line.data = linestr;
		const close = line.data.lastIndexOf("/>");
		if (close === -1) continue;
		line.data = line.data.substr(0, close);

		line.skipSpace();
		if (!line.startsWith("<")) continue;
		out.push(new Tag(line, lineNumber));
	}
	return out;
}

export function normalize(src:string[]):string[]
{
	const sort = new Set<string>();
	for (const s of src)
	{
		sort.add(path.resolve(s));
	}
	return [...sort.values()].sort();
}