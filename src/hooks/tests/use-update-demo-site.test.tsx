// To run tests, execute `npm test src/hooks/tests/use-update-demo-site.test.ts` from the root directory
import { act, renderHook } from '@testing-library/react';
import { ReactNode } from 'react';
import { getIpcApi } from '../../lib/get-ipc-api';
import { useAuth } from '../use-auth';
import { useSnapshots } from '../use-snapshots';
import { useUpdateDemoSite, DemoSiteUpdateProvider } from '../use-update-demo-site';

jest.mock( '../../hooks/use-snapshots' );
jest.mock( '../../hooks/use-auth' );
jest.mock( '../../lib/get-ipc-api', () => ( {
	getIpcApi: jest.fn().mockReturnValue( {
		archiveSite: jest.fn().mockResolvedValue( {
			archivePath: '/mock/path/archive.zip',
			archiveSizeInBytes: 1000,
		} ),
		getFileContent: jest.fn().mockResolvedValue( new Uint8Array( [ 1, 2, 3, 4 ] ).buffer ),
		showErrorMessageBox: jest.fn().mockResolvedValue( { response: 1 } ),
		getWpVersion: jest.fn().mockResolvedValue( '6.5' ),
		removeTemporalFile: jest.fn(),
		showNotification: jest.fn(),
	} ),
} ) );
jest.mock( '@sentry/electron/renderer', () => ( {
	captureException: jest.fn(),
} ) );

global.File = jest.fn().mockImplementation( ( blobParts, fileName, options ) => ( {
	...new Blob( blobParts, options ),
	name: fileName,
	type: options.type,
} ) );

const wrapper = ( { children }: { children: ReactNode } ) => (
	<DemoSiteUpdateProvider>{ children }</DemoSiteUpdateProvider>
);

describe( 'useUpdateDemoSite', () => {
	// Mock data and responses
	const mockSnapshot: Snapshot = {
		atomicSiteId: 12345,
		localSiteId: '54321',
		url: '',
		date: 0,
	};
	const mockLocalSite: SiteDetails = {
		name: 'Test Site',
		running: false,
		phpVersion: '8.0',
		id: '54321',
		path: '/path/to/site',
	};
	const clientReqPost = jest.fn().mockResolvedValue( {
		data: 'success',
	} );
	const updateSnapshotMock = jest.fn();

	beforeEach( () => {
		jest.clearAllMocks();
		jest.useFakeTimers();

		( useAuth as jest.Mock ).mockImplementation( () => ( {
			client: {
				req: {
					post: clientReqPost,
				},
			},
		} ) );

		( useSnapshots as jest.Mock ).mockImplementation( () => ( {
			updateSnapshot: updateSnapshotMock,
		} ) );
	} );

	it( 'when an update succeeds, ensure all functions to update a demo site are called', async () => {
		clientReqPost.mockResolvedValue( {
			data: 'success',
		} );

		const { result } = renderHook( () => useUpdateDemoSite(), { wrapper } );

		await act( async () => {
			await result.current.updateDemoSite( mockSnapshot, mockLocalSite );
			jest.advanceTimersByTime( 3000 );
		} );

		// Assert that archive site is called
		expect( getIpcApi().archiveSite ).toHaveBeenCalledWith( mockLocalSite.id, 'zip' );

		// Assert that file content is retrieved
		expect( getIpcApi().getFileContent ).toHaveBeenCalledWith( '/mock/path/archive.zip' );

		// Assert that 'update-site-from-zip' endpoint is correctly called
		expect( clientReqPost ).toHaveBeenCalledWith( {
			path: '/jurassic-ninja/update-site-from-zip',
			apiNamespace: 'wpcom/v2',
			formData: [
				[ 'site_id', mockSnapshot.atomicSiteId ],
				[
					'import',
					expect.objectContaining( {
						name: 'loca-env-site-1.zip',
						type: 'application/zip',
					} ),
				],
				[ 'wordpress_version', '6.5' ],
			],
		} );

		// Assert that 'isDemoSiteUpdating' is set back to false
		expect( result.current.isDemoSiteUpdating( mockSnapshot.atomicSiteId ) ).toBe( false );

		// Assert that demo site is updated with a new expiration date
		expect( updateSnapshotMock ).toHaveBeenCalledWith(
			expect.objectContaining( {
				...mockSnapshot,
				date: expect.any( Number ),
			} )
		);

		// Assert that success notification is shown
		expect( getIpcApi().showNotification ).toHaveBeenCalledWith( {
			title: 'Update Successful',
			body: "Demo site for 'Test Site' has been updated.",
		} );
	} );

	it( 'when an update fails, ensure an alert is triggered', async () => {
		const error = new Error( 'Update failed' );
		clientReqPost.mockRejectedValue( error );

		const { result } = renderHook( () => useUpdateDemoSite(), { wrapper } );

		await act( async () => {
			await result.current.updateDemoSite( mockSnapshot, mockLocalSite );
			jest.advanceTimersByTime( 3000 );
		} );

		// Assert that an alert is displayed to inform users of the failure
		expect( getIpcApi().showErrorMessageBox ).toHaveBeenCalledWith( {
			title: 'Update failed',
			message: "We couldn't update the Test Site demo site. Please try again.",
			error,
		} );

		// Assert that 'isDemoSiteUpdating' is set back to false
		expect( result.current.isDemoSiteUpdating( mockSnapshot.atomicSiteId ) ).toBe( false );
	} );

	it( 'should allow updating two sites independently with different completion times', async () => {
		const mockSnapshot2: Snapshot = {
			atomicSiteId: 67890,
			localSiteId: '09876',
			url: '',
			date: 0,
		};
		const mockLocalSite2: SiteDetails = {
			name: 'Test Site 2',
			running: false,
			phpVersion: '8.0',
			id: '09876',
			path: '/path/to/site2',
		};

		// Mock different response times for each site
		clientReqPost.mockImplementation( ( args ) => {
			if ( args.formData[ 0 ][ 1 ] === mockSnapshot.atomicSiteId ) {
				return new Promise( ( resolve ) =>
					setTimeout( () => resolve( { data: 'success' } ), 1000 )
				);
			} else {
				return new Promise( ( resolve ) =>
					setTimeout( () => resolve( { data: 'success' } ), 2000 )
				);
			}
		} );

		const { result } = renderHook( () => useUpdateDemoSite(), { wrapper } );

		// Start updating both sites
		await act( async () => {
			result.current.updateDemoSite( mockSnapshot, mockLocalSite );
			result.current.updateDemoSite( mockSnapshot2, mockLocalSite2 );
		} );

		// Initially, both sites should be marked as updating
		expect( result.current.isDemoSiteUpdating( mockSnapshot.atomicSiteId ) ).toBe( true );
		expect( result.current.isDemoSiteUpdating( mockSnapshot2.atomicSiteId ) ).toBe( true );

		// Wait for the first site to complete
		await act( async () => {
			jest.advanceTimersByTime( 1000 );
			await Promise.resolve();
		} );

		// After 1000ms, the first site should be done, but the second should still be updating
		expect( result.current.isDemoSiteUpdating( mockSnapshot.atomicSiteId ) ).toBe( false );
		expect( result.current.isDemoSiteUpdating( mockSnapshot2.atomicSiteId ) ).toBe( true );

		// Wait for the second site to complete
		await act( async () => {
			jest.advanceTimersByTime( 1000 );
			await Promise.resolve();
		} );

		// After another 1000ms, both sites should be done updating
		expect( result.current.isDemoSiteUpdating( mockSnapshot.atomicSiteId ) ).toBe( false );
		expect( result.current.isDemoSiteUpdating( mockSnapshot2.atomicSiteId ) ).toBe( false );

		// Assert that the update function was called for both sites
		expect( clientReqPost ).toHaveBeenCalledTimes( 2 );
		expect( clientReqPost ).toHaveBeenCalledWith(
			expect.objectContaining( {
				path: '/jurassic-ninja/update-site-from-zip',
				apiNamespace: 'wpcom/v2',
				formData: expect.arrayContaining( [
					[ 'site_id', mockSnapshot.atomicSiteId ],
					expect.arrayContaining( [] ),
					[ 'wordpress_version', '6.5' ],
				] ),
			} )
		);
		expect( clientReqPost ).toHaveBeenCalledWith(
			expect.objectContaining( {
				path: '/jurassic-ninja/update-site-from-zip',
				apiNamespace: 'wpcom/v2',
				formData: expect.arrayContaining( [
					[ 'site_id', mockSnapshot2.atomicSiteId ],
					expect.arrayContaining( [] ),
					[ 'wordpress_version', '6.5' ],
				] ),
			} )
		);

		// Assert that updateSnapshot was called for both sites
		expect( updateSnapshotMock ).toHaveBeenCalledTimes( 2 );
		expect( updateSnapshotMock ).toHaveBeenCalledWith(
			expect.objectContaining( {
				...mockSnapshot,
				date: expect.any( Number ),
			} )
		);
		expect( updateSnapshotMock ).toHaveBeenCalledWith(
			expect.objectContaining( {
				...mockSnapshot2,
				date: expect.any( Number ),
			} )
		);
	} );
	afterEach( () => {
		jest.restoreAllMocks();
	} );
} );
