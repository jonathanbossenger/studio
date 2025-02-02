// To run tests, execute `npm run test -- src/lib/import-export/tests/import/handlers/backup-handler-factory.test.ts`
import fs from 'fs';
import path from 'path';
import { Readable, Writable } from 'stream';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import { BackupHandlerFactory } from '../../../import/handlers/backup-handler-factory';
import { BackupHandlerSql } from '../../../import/handlers/backup-handler-sql';
import { BackupHandlerTarGz } from '../../../import/handlers/backup-handler-tar-gz';
import { BackupHandlerZip } from '../../../import/handlers/backup-handler-zip';
import { BackupArchiveInfo } from '../../../import/types';

jest.mock( 'fs' );
jest.mock( 'fs/promises' );
jest.mock( 'zlib' );
jest.mock( 'tar' );
jest.mock( 'yauzl' );
jest.mock( 'path' );

// Mock types to match yauzl and Node.js stream interfaces
interface MockZipFile {
	on: jest.Mock;
	readEntry: jest.Mock;
	openReadStream?: jest.Mock;
}

interface MockReadStream extends Partial< Readable > {
	on: jest.Mock;
	pipe: jest.Mock;
}

interface MockWriteStream extends Partial< Writable > {
	on: jest.Mock;
}

describe( 'BackupHandlerFactory', () => {
	beforeEach( () => {
		jest.clearAllMocks();
	} );

	describe( 'create', () => {
		it( 'should create a handler for gzip archives', () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.tar.gz',
				type: 'application/gzip',
			};
			( path.extname as jest.Mock ).mockReturnValue( '.gz' );
			const handler = BackupHandlerFactory.create( archiveInfo );
			expect( handler ).toBeInstanceOf( BackupHandlerTarGz );
		} );

		it( 'should create a handler for zip archives', () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.zip',
				type: 'application/zip',
			};
			( path.extname as jest.Mock ).mockReturnValue( '.zip' );
			const handler = BackupHandlerFactory.create( archiveInfo );
			expect( handler ).toBeInstanceOf( BackupHandlerZip );
		} );

		it( 'should create a handler for SQL files', () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.sql',
				type: 'application/sql',
			};
			( path.extname as jest.Mock ).mockReturnValue( '.sql' );
			const handler = BackupHandlerFactory.create( archiveInfo );
			expect( handler ).toBeInstanceOf( BackupHandlerSql );
		} );

		it( 'should return undefined handler for unsupported file types', () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.unknown',
				type: 'application/unknown',
			};
			( path.extname as jest.Mock ).mockReturnValue( '.unknown' );
			const handler = BackupHandlerFactory.create( archiveInfo );
			expect( handler ).toBeUndefined();
		} );
	} );

	describe( 'listFiles', () => {
		const archiveFiles = [
			'index.php',
			'.hidden-file',
			'wp-content/.hidden-file',
			'wp-content/plugins/hello.php',
			'wp-content/themes/twentytwentyfour/theme.json',
			'wp-content/uploads/2024/07/image.png',
			'__MACOSX/meta-file',
		];
		const expectedArchiveFiles = [
			'index.php',
			'wp-content/plugins/hello.php',
			'wp-content/themes/twentytwentyfour/theme.json',
			'wp-content/uploads/2024/07/image.png',
		];

		it( 'should list files from a gzip archive', async () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.tar.gz',
				type: 'application/gzip',
			};
			const handler = BackupHandlerFactory.create( archiveInfo );

			jest.spyOn( tar, 't' ).mockImplementation( ( { onReadEntry } ) => {
				archiveFiles.forEach( ( path ) => onReadEntry?.( { path } as tar.ReadEntry ) );
			} );

			await expect( handler?.listFiles( archiveInfo ) ).resolves.toEqual( expectedArchiveFiles );
		} );

		it( 'should list files from a zip archive', async () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.zip',
				type: 'application/zip',
			};
			const handler = BackupHandlerFactory.create( archiveInfo );

			const mockZipFile: MockZipFile = {
				on: jest.fn().mockImplementation( ( event, callback ) => {
					if ( event === 'entry' ) {
						archiveFiles.forEach( ( file ) => callback( { fileName: file } ) );
					} else if ( event === 'end' ) {
						callback();
					}
					return mockZipFile;
				} ),
				readEntry: jest.fn(),
			};

			( yauzl.open as jest.Mock ).mockImplementation( ( path, options, callback ) => {
				callback( null, mockZipFile );
			} );

			await expect( handler?.listFiles( archiveInfo ) ).resolves.toEqual( expectedArchiveFiles );
		} );

		it( 'should list a single SQL file', async () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.sql',
				type: 'application/sql',
			};
			const handler = BackupHandlerFactory.create( archiveInfo );
			( path.basename as jest.Mock ).mockReturnValue( 'backup.sql' );
			const result = await handler?.listFiles( archiveInfo );
			expect( result ).toEqual( [ 'backup.sql' ] );
		} );
	} );

	describe( 'extractFiles', () => {
		it( 'should extract files from a gzip archive', async () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.tar.gz',
				type: 'application/gzip',
			};
			const handler = BackupHandlerFactory.create( archiveInfo );
			const extractionDirectory = '/tmp/extracted';

			const createReadStreamMock: unknown = {
				on: jest.fn( ( event, callback ) => {
					if ( event === 'finish' ) {
						callback();
					}
					return createReadStreamMock;
				} ),
				pipe: jest.fn().mockReturnThis(),
			};
			( fs.createReadStream as jest.Mock ).mockReturnValue( createReadStreamMock );
			( fs.statSync as jest.Mock ).mockResolvedValueOnce( 1000 );

			await expect(
				handler?.extractFiles( archiveInfo, extractionDirectory )
			).resolves.not.toThrow();
			expect( tar.x ).toHaveBeenCalledWith( {
				cwd: extractionDirectory,
			} );
		} );

		it( 'should extract files from a zip archive', async () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.zip',
				type: 'application/zip',
			};
			const handler = BackupHandlerFactory.create( archiveInfo );
			const extractionDirectory = '/tmp/extracted';

			const mockReadStream: MockReadStream = {
				on: jest.fn().mockImplementation( ( event, callback ) => {
					if ( event === 'data' ) {
						callback( Buffer.from( 'test data' ) );
					}
					return mockReadStream;
				} ),
				pipe: jest.fn().mockReturnThis(),
			};

			const mockWriteStream: MockWriteStream = {
				on: jest.fn().mockImplementation( ( event, callback ) => {
					if ( event === 'finish' ) {
						callback();
					}
					return mockWriteStream;
				} ),
			};

			const mockZipFile: MockZipFile = {
				on: jest.fn().mockImplementation( ( event, callback ) => {
					if ( event === 'entry' ) {
						callback( { fileName: 'test.txt' } );
					} else if ( event === 'end' ) {
						callback();
					}
					return mockZipFile;
				} ),
				readEntry: jest.fn(),
				openReadStream: jest.fn().mockImplementation( ( entry, callback ) => {
					callback( null, mockReadStream );
				} ),
			};

			( yauzl.open as jest.Mock ).mockImplementation( ( path, options, callback ) => {
				callback( null, mockZipFile );
			} );
			( fs.createWriteStream as jest.Mock ).mockReturnValue( mockWriteStream );
			( fs.statSync as jest.Mock ).mockReturnValue( { size: 1000 } );

			await expect(
				handler?.extractFiles( archiveInfo, extractionDirectory )
			).resolves.not.toThrow();

			// Verify zip file was opened with correct options
			expect( yauzl.open ).toHaveBeenCalledWith(
				archiveInfo.path,
				{ lazyEntries: true },
				expect.any( Function )
			);

			// Verify readEntry was called to start reading entries
			expect( mockZipFile.readEntry ).toHaveBeenCalled();

			// Verify openReadStream was called for the entry
			expect( mockZipFile.openReadStream ).toHaveBeenCalledWith(
				{ fileName: 'test.txt' },
				expect.any( Function )
			);

			// Verify write stream was created with correct path
			expect( fs.createWriteStream ).toHaveBeenCalledWith(
				path.join( extractionDirectory, 'test.txt' )
			);

			// Verify pipe was called to connect read and write streams
			expect( mockReadStream.pipe ).toHaveBeenCalledWith( mockWriteStream );

			// Verify event handlers were set up
			expect( mockReadStream.on ).toHaveBeenCalledWith( 'data', expect.any( Function ) );
			expect( mockWriteStream.on ).toHaveBeenCalledWith( 'finish', expect.any( Function ) );
		} );

		it( 'should copy SQL file to extraction directory', async () => {
			const archiveInfo: BackupArchiveInfo = {
				path: '/path/to/backup.sql',
				type: 'application/sql',
			};
			const handler = BackupHandlerFactory.create( archiveInfo );
			const extractionDirectory = '/tmp/extracted';
			( path.basename as jest.Mock ).mockReturnValue( 'backup.sql' );
			( fs.promises.copyFile as jest.Mock ).mockResolvedValue( undefined );

			await expect(
				handler?.extractFiles( archiveInfo, extractionDirectory )
			).resolves.not.toThrow();
			expect( fs.promises.copyFile ).toHaveBeenCalledWith(
				archiveInfo.path,
				path.join( extractionDirectory, 'backup.sql' )
			);
		} );
	} );
} );
