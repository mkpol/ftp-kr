
import { window, workspace } from 'vscode';
import { File, Stats } from 'krfile';

import { ServerConfig } from './util/serverinfo';
import { ftp_path } from './util/ftp_path';
import { VFSState, VirtualFileSystem, VFSFile, VFSDirectory, VFSFileCommon, VFSServer } from './util/filesystem';
import { Deferred, isEmptyObject } from './util/util';

import { DIRECTORY_NOT_FOUND, FILE_NOT_FOUND } from './vsutil/fileinterface';
import { WorkspaceItem, Workspace } from './vsutil/ws';
import { vsutil, QuickPick } from './vsutil/vsutil';
import { Logger } from './vsutil/log';
import { Task, Scheduler, PRIORITY_NORMAL } from './vsutil/work';

import { Config } from './config';
import { FtpManager } from './ftpmgr';

export interface BatchOptions
{
	// in
	doNotRefresh?:boolean;
	doNotMakeDirectory?:boolean;
	ignoreNotExistFile?:boolean;
	forceRefresh?:boolean;
	cancelWhenLatest?:boolean;
	whenRemoteModed?:"upload"|"diff"|"ignore";
}

function testLatest(file:VFSState|undefined, localStat:Stats):boolean
{
    if (!file) return false;
    switch(file.type)
    {
    case "-":
        if (!localStat.isFile()) return false;
		if (file instanceof VFSFileCommon)
		{
    		if (localStat.size !== file.size) return false;
		}
        break;
    case "d":
        if (!localStat.isDirectory()) return false;
        break;
    case "l":
        if (!localStat.isSymbolicLink()) return false;
        break;
    }
    return true;
}


class RefreshedData extends Deferred<VFSDirectory>
{
	accessTime:number = new Date().valueOf();

	constructor()
	{
		super();
	}
}

export class UploadReport
{
	directoryIgnored?:boolean;
	latestIgnored?:boolean;
	modifiedIgnore?:boolean;
	noFileIgnored?:boolean;
	file?:VFSState;
}

export interface TaskList
{
	[key:string]:string;
}

export interface ViewedFile
{
	file?:VFSState;
	content:string;
}

interface TaskJsonResult
{
	tasks:TaskList;
	count:number;
}


export class FtpCacher
{
	public readonly mainConfig:Config;
	private readonly ftpmgr:FtpManager;

	private readonly refreshed:Map<string, RefreshedData> = new Map;
	public readonly logger:Logger;
	public readonly scheduler:Scheduler;

	public readonly fs:VFSServer;
	public home:VFSDirectory;
	public remotePath:string;

	constructor(public readonly workspace:Workspace, public readonly config:ServerConfig, fs:VirtualFileSystem)
	{
		this.mainConfig = workspace.query(Config);
		this.config = config;
		this.ftpmgr = new FtpManager(workspace, this.config);
		this.scheduler = workspace.query(Scheduler);

		this.fs = fs.item(config.hostUrl || '');
		this.logger = workspace.query(Logger);
		
		this.home = <any>undefined;
		this.remotePath = <any>undefined;
	}

	public getName():string
	{
		var name = this.workspace.name;
		if (this.config.name) name += '/' + this.config.name;
		return name;
	}
	
	public async init(task:Task):Promise<void>
	{
		await this.ftpList(this.config.remotePath, task).then(()=>{});
		const remotePath = this.config.remotePath;
		this.remotePath = remotePath.startsWith('/') ? remotePath : ftp_path.normalize(this.ftpmgr.home+'/'+remotePath);
		this.home = <VFSDirectory>this.fs.getFromPath(this.remotePath, true);
	}

	public async initForRemotePath(task?:Task|null):Promise<void>
	{
		if (!this.remotePath)
		{
			await this.scheduler.task('First Connect', task => this.init(task), task);
		}
	}

	public terminate():void
	{
		this.ftpmgr.terminate();
	}

	public toWorkPathFromFtpPath(ftppath:string):string
	{
		ftppath = ftp_path.normalize(ftppath);
		if (ftppath === this.remotePath) return '.';
		if (!ftppath.startsWith(this.remotePath+'/')) throw Error(`${ftppath} is not in remotePath`);
		return ftppath.substr(this.remotePath.length+1);
	}

	public toFtpFileFromFtpPath(ftppath:string):VFSState|undefined
	{
		const parent = ftp_path.dirname(ftppath);
		const dir = this.fs.getFromPath(parent);
		if (!dir) return undefined;
		return dir.item(ftp_path.basename(ftppath));
	}

	public toFtpPath(path:File):string
	{
		return ftp_path.normalize(this.remotePath + this.mainConfig.workpath(path));
	}

	public toFtpFile(path:File):VFSState|undefined
	{
		return this.toFtpFileFromFtpPath(this.toFtpPath(path));
	}

	public toFtpUrl(path:File):string
	{
		const ftppath = this.toFtpPath(path);
		return this.config.hostUrl + ftppath;
	}

	public fromFtpFile(ftpfile:VFSState):File
	{
		console.assert(ftpfile instanceof VFSState);
		const ftppath = ftpfile.getPath();
		return this.fromFtpPath(ftppath);
	}

	public fromFtpPath(ftppath:string):File
	{
		return this.mainConfig.basePath.child(this.toWorkPathFromFtpPath(ftppath));
	}

	public ftpDelete(path:File, task?:Task|null, options?:BatchOptions):Promise<void>
	{
		return this.scheduler.task('ftpkr.delete', async(task)=>{
			await this.initForRemotePath(task);
			const ftppath = this.toFtpPath(path);
	
			const deleteTest = async(file:VFSState):Promise<void>=>{
				if (file instanceof VFSDirectory) await this.ftpmgr.rmdir(task, ftppath);
				else await this.ftpmgr.remove(task, ftppath);
				this._fsDelete(ftppath);
			}
	
			var file:VFSState|undefined = this.fs.getFromPath(ftppath);
			if (file)
			{
				try
				{
					return await deleteTest(file);
				}
				catch(err)
				{
				}
			}
			file = await this.ftpStat(ftppath, task, options);
			if (!file) return;
			await deleteTest(file);
		}, task);
	}

	public ftpUpload(path:File, task?:Task|null, options?:BatchOptions):Promise<UploadReport>
	{
		return this.scheduler.task('Upload', async (task) => {
			await this.initForRemotePath(task);
	
			const noptions = options || {};
			const ftppath = this.toFtpPath(path);
			const report = new UploadReport;
		
			var stats:Stats;
			var oldfile:VFSState|undefined = undefined;
			
			try
			{
				stats = await path.stat();
			}
			catch(e)
			{
				if (e.code === 'ENOENT' && noptions.ignoreNotExistFile)
				{
					report.noFileIgnored = true;
					return report;
				}
				throw e;
			}
			
			const next = async ():Promise<UploadReport>=>{
				if (stats.isDirectory())
				{
					if (noptions.doNotMakeDirectory)
					{
						report.directoryIgnored = true;
						return report;
					}
	
					if (oldfile)
					{
						if (oldfile instanceof VFSDirectory)
						{
							oldfile.lmtimeWithThreshold = oldfile.lmtime = +stats.mtime;
							report.file = oldfile;
							return report;
						}
						await this.ftpDelete(path, task).then(() => this.ftpmgr.mkdir(task, ftppath));
					}
					else
					{
						await this.ftpmgr.mkdir(task, ftppath);
					}
	
					const dir = this.fs.mkdir(ftppath);
					dir.lmtimeWithThreshold = dir.lmtime = +stats.mtime;
					dir.modified = false;
					report.file = dir;
					return report;
				}
				else
				{
					const parentFtpPath = this.toFtpPath(path.parent());
					try
					{
						await this.ftpmgr.upload(task, ftppath, path);
					}
					catch(e)
					{
						if (e.code === 'ENOENT' && noptions.ignoreNotExistFile)
						{
							report.noFileIgnored = true;
							return report;
						}
						throw e;
					}
	
					const file = this.fs.createFromPath(ftppath);
					file.lmtimeWithThreshold = file.lmtime = +stats.mtime;
					file.size = stats.size;
					report.file = file;
					return report;
				}
			};
	
			const parentFtpPath = this.toFtpPath(path.parent());
			const filedir = this.fs.getFromPath(parentFtpPath);
			if (!filedir) return await next();
			
			oldfile = await this.ftpStat(ftppath, task);
			if (!oldfile) return await next();
	
			if (!noptions.cancelWhenLatest && noptions.whenRemoteModed === 'upload')
			{
				return await next();
			}
	
	
			const mtime = +stats.mtime;
			const isLatest = mtime === oldfile.lmtime || mtime <= oldfile.lmtimeWithThreshold;
			
			if (isLatest)
			{
				if (noptions.cancelWhenLatest)
				{
					report.latestIgnored = true;
					report.file = oldfile;
					return report;
				}
			}
	
			if (oldfile.modified)
			{
				switch (noptions.whenRemoteModed)
				{
				case 'upload':
					return await next();
				case 'ignore':
					report.modifiedIgnore = true;
					report.file = oldfile;
					return report;
				case 'diff':
				default:
					var diffFile:File;
					try
					{
						diffFile = await this.ftpDiff(path, task, true);
					}
					catch (err)
					{
						if (err === 'SAME')
						{
							report.file = oldfile;
							return report;
						}
						throw err;
					}
					const selected = await vsutil.info('Remote file modification detected', 'Upload', 'Download');
					try
					{
						await diffFile.unlink();
					}
					catch(err)
					{
					}
					switch (selected)
					{
					case 'Upload':
						return await next();
					case 'Download':
						await this.ftpDownload(path, task);
						throw 'IGNORE';
					case undefined:
						throw 'IGNORE';
					}
					break;
				}
			}
	
			return await next();
		}, task);
	}

	public async ftpDownload(path:File, task?:Task|null, options?:BatchOptions):Promise<void>
	{
		await this.scheduler.task('ftpkr.download', async (task) => {
			await this.initForRemotePath(task);
			const ftppath = this.toFtpPath(path);
			var file:VFSState|undefined = this.fs.getFromPath(ftppath);
			if (!file)
			{
				file = await this.ftpStat(ftppath, task, options);
				if (!file)
				{
					throw Error(`Not found in remote: ${ftppath}`);
				}
			}
	
			if (file instanceof VFSDirectory) await path.mkdirp();
			else
			{
				await path.parent().mkdirp();
				await this.ftpmgr.download(task, path, ftppath);
			}
			const stats = await path.stat();
			file.lmtime = +stats.mtime;
			file.lmtimeWithThreshold = file.lmtime + this.mainConfig.downloadTimeExtraThreshold;
			file.modified = false;
		}, task);
	}

	public downloadAsText(ftppath:string, task?:Task|null):Promise<ViewedFile>
	{
		return this.scheduler.task<ViewedFile>('View', async(task):Promise<ViewedFile>=>{
			var file:VFSState|undefined = this.fs.getFromPath(ftppath);
			if (!file)
			{
				file = await this.ftpStat(ftppath, task);
				if (!file)
				{
					return {
						content: '< File not found >\n'+ftppath
					};
				}
			}
			if (file.size > this.mainConfig.viewSizeLimit) return {
				content: '< File is too large >\nYou can change file size limit with "viewSizeLimit" option in ftp-kr.json'
			};
			const content = await this.ftpmgr.view(task, ftppath);
			return {
				file,
				content
			};
		}, task);
	}

	public async ftpDownloadWithCheck(path:File, task:Task):Promise<void>
	{
		await this.initForRemotePath(task);
		const ftppath = this.toFtpPath(path);

		try
		{
			var stats = await path.stat();
		}
		catch(e)
		{
			if (e.code === 'ENOENT') return; // vscode open "%s.git" file, why?
			throw e;
		}
		const file = await this.ftpStat(ftppath, task);
		if (!file || (file.lmtime !== 0 && file.lmtime < +stats.mtime))
		{
			if (this.mainConfig === this.config && this.mainConfig.autoUpload)
			{
				await this.ftpUpload(path, task, {whenRemoteModed: this.mainConfig.ignoreRemoteModification?'ignore':'diff'});
			}
			else
			{
				// diff?
			}
			return;
		}

		if (file instanceof VFSFile && stats.size === file.size) return;
		if (file instanceof VFSDirectory) await path.mkdir();
		else
		{
			await path.parent().mkdirp();
			await this.ftpmgr.download(task, path, ftppath);
		}
		stats = await path.stat();
		file.lmtime = +stats.mtime;
		file.lmtimeWithThreshold = file.lmtime + this.mainConfig.downloadTimeExtraThreshold;
		file.modified = false;
	}

	public async ftpStat(ftppath:string, task:Task, options?:BatchOptions):Promise<VFSState|undefined>
	{
		const parent = ftp_path.dirname(ftppath);
		const dir = await this.ftpList(parent, task, options);
		return dir.item(ftp_path.basename(ftppath));
	}

	public ftpTargetStat(linkfile:VFSState, task?:Task|null):Promise<VFSState|undefined>
	{
		return this.scheduler.task('Read Link', async(task)=>{
			for (;;)
			{
				console.assert(linkfile instanceof VFSState);
				const target = await this.ftpmgr.readlink(task, linkfile, linkfile.getPath());
				const stats = await this.ftpStat(target, task);
				if (!stats) return undefined;
				linkfile = stats;
				if (linkfile.type !== 'l') return linkfile;
			}
		}, task);
	}

	public ftpDiff(file:File, task?:Task|null, sameCheck?:boolean):Promise<File>
	{
		return this.scheduler.task('Diff', async(task)=>{
			await this.initForRemotePath(task);
			const basename = file.basename();
			const diffFile:File = await this.workspace.child('.vscode/ftp-kr.diff.'+basename).findEmptyIndex();
			var title:string = basename + ' Diff';
			try
			{
				const ftppath = this.toFtpPath(file);
				await this.ftpmgr.download(task, diffFile, ftppath);
			}
			catch (err)
			{
				if (err.ftpCode !== FILE_NOT_FOUND) throw err;
				await diffFile.create("");
				title += ' (NOT FOUND)';
			}
			if (sameCheck)
			{
				const remoteContent = await diffFile.open();
				const localContent = await file.open();
				if (remoteContent === localContent)
				{
					await diffFile.quietUnlink();
					throw 'SAME';
				}
			}
			vsutil.diff(diffFile, file, title).then(()=>diffFile.quietUnlink());
			return diffFile;
		}, task);
	}

	public ftpList(ftppath:string, task?:Task|null, options?:BatchOptions):Promise<VFSDirectory>
	{
		return this.scheduler.task('List', task=>{
			const latest = this.refreshed.get(ftppath);
			if (latest)
			{
				if (options && options.doNotRefresh) return latest;
				if (!options || !options.forceRefresh)
				{
					if (latest.accessTime + this.mainConfig.refreshTime > Date.now()) return latest;
				}
			}
			const deferred = new RefreshedData;
			this.refreshed.set(ftppath, deferred);
	
			return (async()=>{
				await this.ftpmgr.init(task);
	
				try
				{
					const ftpfiles = await this.ftpmgr.list(task, ftppath);
					const dir = this.fs.refresh(ftppath, ftpfiles);
					deferred.resolve(dir);
					return dir;
				}
				catch(err)
				{
					deferred.catch(() => {});
					deferred.reject(err);
					if (this.refreshed.get(ftppath) === deferred)
					{
						this.refreshed.delete(ftppath);
					}
					throw err;
				}
			})();
		}, task);
	}

	public refresh(ftpFile?:VFSState):void
	{
		if (ftpFile)
		{
			const ftppath = ftpFile.getPath();
			for (const path of this.refreshed.keys())
			{
				if (ftppath === path || ftppath.startsWith(path+'/'))
				{
					this.refreshed.delete(path);
				}
			}
		}
		else
		{
			this.refreshed.clear();
		}
	}

	public async runTaskJson(parentDirectory:File, tasklist:TaskList, task:Task):Promise<TaskJsonResult|null>
	{
		await this.initForRemotePath(task);
		const options:BatchOptions = {
			doNotRefresh:true, 
			whenRemoteModed:'upload'
		};

		var errorCount = 0;
		const failedTasks:TaskList = {};

		for (const workpath in tasklist)
		{
			const exec = tasklist[workpath];
			const path = this.mainConfig.fromWorkpath(workpath, parentDirectory);
			try
			{
				switch (exec)
				{
				case 'upload': await this.ftpUpload(path, task, options); break;
				case 'download': await this.ftpDownload(path, task, options); break;
				case 'delete': await this.ftpDelete(path, task, options); break;
				default:
					const [cmd, preposition, relpath] = exec.split(/[ \t]+/g, 3);
					switch (cmd)
					{
					case 'upload':
						switch (preposition){
						case 'from':{
							const ftppath = this.toFtpPath(path);
							const localpath = path.parent().child(relpath);
							await this.ftpmgr.upload(task, ftppath, localpath);
							break;
						}
						case 'to':{
							const ftppath = ftp_path.normalize(this.toFtpPath(path.parent())+'/'+relpath);
							await this.ftpmgr.upload(task, ftppath, path);
							break;
						}
						default:
							throw Error(`Invalid command: ${exec}\n'upload from/to path'`);
						}
						break;
					case 'download':
						switch (preposition){
						case 'from':{
							const ftppath = ftp_path.normalize(this.toFtpPath(path.parent())+'/'+relpath);
							await this.ftpmgr.download(task, path, ftppath);
							break;
						}
						case 'to':{
							const ftppath = this.toFtpPath(path);
							const localpath = path.parent().child(relpath);
							await this.ftpmgr.download(task, localpath, ftppath);
							break;
						}
						default:
							throw Error(`Invalid command: ${exec}\n'download from/to path'`);
						}
						break;
					default:
						throw Error(`Invalid command: ${exec}\n'upload' or 'download' or 'upload to path' or 'download from path'`);
					}
					break;
				}
			}
			catch(err)
			{
				failedTasks[workpath] = exec;
				if (err.code === 'ENOENT')
				{
					this.logger.message("Error: file not found: '"+workpath+"'");
				}
				else
				{
					console.error(err);
					this.logger.message(err);
				}
				errorCount ++;
			}
		}
		if (errorCount)
			return {tasks:failedTasks, count:errorCount};
		else return null;
	}

	public async runTaskJsonWithConfirm(taskName:string, tasks: TaskList, taskname: string, parentDirectory:File, confirmFirst:boolean): Promise<void>
	{
		var confirmer:(()=>Thenable<string|undefined>)|null = null;
		
		if (confirmFirst)
		{
			confirmer = ()=>vsutil.info("Review Operations to perform.", "OK");
		}

		for (;;)
		{
			if (isEmptyObject(tasks)) 
			{
				vsutil.info("Nothing to DO");
				return;
			}
			if (confirmer)
			{
				const taskFile = this.workspace.child(".vscode/ftp-kr.task.json");
				try
				{
					await taskFile.create(JSON.stringify(tasks, null, 1));
					await vsutil.open(taskFile);
					const res = await confirmer();
					if (res === undefined) return;
					const editor = await vsutil.open(taskFile);
					if (editor) await editor.document.save();
					const data = await taskFile.json();
				}
				finally
				{
					await taskFile.quietUnlink();
				}
			}

			this.logger.show();
			this.logger.message(taskname + ' started');
			const startTime = Date.now();
			
			const failed = await this.scheduler.task(taskName, task=>this.runTaskJson(parentDirectory, tasks, task));
			if (!failed) 
			{
				const passedTime = Date.now() - startTime;
				if (passedTime > 1000) {
					vsutil.info(taskname + " completed");
				}
				this.logger.show();
				this.logger.message(taskname + ' completed');
				return;
			}

			tasks = failed.tasks;
			confirmer = () => this.logger.errorConfirm("ftp-kr Task failed, more information in the output", "Retry");
		}
	}

	public async uploadAll(path: File, task?:Task): Promise<void>
	{
		await this.scheduler.task('Upload All', async (task) => {
			const tasks = await this._syncTestUpload(path, task);
			await Promise.resolve();
			this.runTaskJsonWithConfirm(task.name, tasks, task.name, this.mainConfig.basePath, true);
		}, task);
	}

	public async downloadAll(path: File, task?:Task): Promise<void>
	{
		await this.scheduler.task('Download All', async(task) => {
			const tasks = await this._syncTestDownload(path, task)
			await Promise.resolve();
			this.runTaskJsonWithConfirm(task.name, tasks, task.name, this.mainConfig.basePath, true);
		}, task);
	}

	public cleanAll(task?:Task|null):Promise<void>
	{
		return this.scheduler.task('Clean All', async(task) => {
			const tasks = await this._syncTestClean(task);
			await Promise.resolve();
			this.runTaskJsonWithConfirm(task.name, tasks, task.name, this.mainConfig.basePath, true);
		}, task);
	}

	public async list(path:File):Promise<void>
	{
		await this.initForRemotePath();
		const openFile = (file:VFSState)=>{
			const npath = path.child(file.name);
			pick.clear();
			pick.item('Download '+file.name, ()=>this.ftpDownload(npath));
			pick.item('Upload '+file.name, ()=>this.ftpUpload(npath, null, {whenRemoteModed: this.mainConfig.ignoreRemoteModification?'upload':'diff'}));
			pick.item('Delete '+file.name, ()=>this.ftpDelete(npath));
			pick.item('View '+file.name, ()=>vsutil.openUri(file.getUrl()));
			pick.item('Diff '+file.name, ()=>this.ftpDiff(npath));
			pick.oncancel = ()=>this.list(path);
			return pick.open();
		};
		const openDirectory = (dir:VFSState)=>this.list(path.child(dir.name));
		const ftppath = this.toFtpPath(path);
		const dir = await this.ftpList(ftppath);
		
		const pick = new QuickPick;
		if (path.fsPath !== this.mainConfig.basePath.fsPath)
		{
			pick.item('Current Directory Action', ()=>{
				const pick = new QuickPick;
				pick.item('Download Current VFSDirectory', ()=>this.downloadAll(path));
				pick.item('Upload Current VFSDirectory', ()=>this.uploadAll(path));
				pick.item('Delete Current VFSDirectory', ()=>this.ftpDelete(path));
				pick.oncancel = ()=>this.list(path);
				return pick.open();
			});
		}
		
		var files:VFSState[] = [];
		var dirs:VFSState[] = [];
		var links:VFSState[] = [];

		if(this.mainConfig.basePath.fsPath !== path.fsPath)
		{
			pick.item('[DIR]\t..', ()=>this.list(path.parent()));
		}

		for(const file of dir.children())
		{
			switch (file.type)
			{
			case 'l':
				links.push(file);
				break;
			case '-':
				files.push(file);
				break;
			case 'd':
				dirs.push(file);
				break;
			}
		}
		files = files.sort((a,b)=>a.name.localeCompare(b.name));
		links = links.sort((a,b)=>a.name.localeCompare(b.name));
		dirs = dirs.sort((a,b)=>a.name.localeCompare(b.name));

		for (const dir of dirs)
		{
			pick.item('[DIR]\t' + dir.name, ()=>openDirectory(dir));
		}

		for (const link of links)
		{
			pick.item('[LINK]\t' + link.name, async()=>{
				const stats = await this.ftpTargetStat(link);
				if (!stats) return await this.list(path);
				switch (stats.type)
				{
				case 'd':
					return await openDirectory(link);
				case '-':
					return await openFile(stats);
				}
			});
		}

		for (const file of files)
		{
			pick.item('[FILE]\t' + file.name, ()=>openFile(file));
		}
		
		await pick.open();
	}
	
	private async _syncTestUpload(path:File, task:Task):Promise<TaskList>
	{
		await this.initForRemotePath(task);
		const list:{[key:string]:Stats} = {};
		await this._getUpdatedFile(this.home, path, list)
		
		const output:TaskList = {};
		for(const workpath in list)
		{
			const path = this.mainConfig.fromWorkpath(workpath, this.mainConfig.basePath);
			const ftppath = this.toFtpPath(path);
			const st = list[workpath];
			
			const file = await this.ftpStat(ftppath, task);
			if (!await testLatest(file, st))
			{
				output[workpath] = "upload";
			}
		}
		return output;
	}

	private _syncTestDownload(path:File, task:Task):Promise<TaskList>
	{
		const list:TaskList = {};
		return this._listNotExists(path, list, true, task)
		.then(() => list);
	}

	private _syncTestClean(task:Task):Promise<TaskList>
	{
		const list:TaskList = {};
		return this._listNotExists(this.mainConfig.basePath, list, false, task)
		.then(() => list);
	}

	private async _listNotExists(path:File, list:TaskList, download:boolean, task:Task):Promise<void>
	{
		if (this.mainConfig.checkIgnorePath(path)) return;
		await this.initForRemotePath(task);
		const command = download ? "download" : "delete"; 
		
		var fslist:File[];
		try
		{
			fslist = await path.children();
		}
		catch (err)
		{
			if (!download) return;
			fslist = [];
		}

		try
		{
			const ftppath = this.toFtpPath(path);
			const dir = await this.ftpList(ftppath, task);
			const targets = new Set<string>();

			const dirlist:File[] = [];
			for(var file of dir.children())
			{
				const fullPath = path.child(file.name);
				if (this.mainConfig.checkIgnorePath(fullPath)) continue;
				if (file.type === 'l')
				{
					if (!this.mainConfig.followLink) continue;
					const nfile = await this.ftpTargetStat(file, task);
					if (!nfile) continue;
					file = nfile;
				}
				targets.add(file.name);
				if (file.type === 'd')
				{
					dirlist.push(fullPath);
				}
			}
			for(const file of fslist)
			{
				targets.delete(file.basename());
			}

			const flushList = ()=>{
				for (const p of targets)
				{
					list[this.mainConfig.workpath(path.child(p))] = command;
				}
			};
			const processChild = async()=>{
				for(const child of dirlist)
				{
					await this._listNotExists(child, list, download, task);
				}
			};
			if (download)
			{
				flushList();
				await processChild();
			}
			else // delete
			{
				await processChild();
				flushList();
			}
		}
		catch(err)
		{
			throw err;
		}
	}

	private async _getUpdatedFileInDir(cmp:VFSDirectory|undefined, path:File, list:{[key:string]:Stats}):Promise<void>
	{
		const files = await path.children();
		for (const child of files)
		{
			var childfile:VFSState|undefined;
			if (cmp)
			{
				const file = cmp.item(child.basename());
				if (file) childfile = file;
			}
			await this._getUpdatedFile(childfile, child, list);
		}
	}
	
	private async _getUpdatedFile(cmp:VFSState|undefined, path:File, list:{[key:string]:Stats}):Promise<void>
	{
		if (this.mainConfig.checkIgnorePath(path)) return;
		try
		{
			const st = await path.lstat();
			if (st.isDirectory()) await this._getUpdatedFileInDir(cmp instanceof VFSDirectory ? cmp : undefined, path, list);
			if (testLatest(cmp, st)) return;
			list[this.mainConfig.workpath(path)] = st;
		}
		catch(err)
		{
		}
	}

	private _deletedir(dir:VFSDirectory, ftppath:string):void
	{
		if (!this.refreshed.delete(ftppath)) return;
		for(const child of dir.children())
		{
			if (!(child instanceof VFSDirectory)) continue;
			this._deletedir(child, ftppath+'/'+child.name);
		}
	}

	private _fsDelete(ftppath:string):void
	{
		const dir = this.fs.getFromPath(ftppath);
		if (dir) this._deletedir(dir, ftppath);
		this.fs.deleteFromPath(ftppath);
	}
}