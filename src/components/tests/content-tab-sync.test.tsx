// To run tests, execute `npm run test -- src/components/tests/content-tab-sync.test.tsx` from the root directory
import { render, screen, fireEvent } from '@testing-library/react';
import { SyncSitesProvider } from '../../hooks/sync-sites/sync-sites-context';
import { useAuth } from '../../hooks/use-auth';
import { useSiteSyncManagement } from '../../hooks/use-site-sync-management';
import { getIpcApi } from '../../lib/get-ipc-api';
import { ContentTabSync } from '../content-tab-sync';

jest.mock( '../../hooks/use-auth' );
jest.mock( '../../lib/get-ipc-api' );
jest.mock( '../../hooks/use-site-sync-management' );

const selectedSite: SiteDetails = {
	name: 'Test Site',
	port: 8881,
	path: '/path/to/site',
	adminPassword: btoa( 'test-password' ),
	running: false,
	phpVersion: '8.0',
	id: 'site-id',
};

describe( 'ContentTabSync', () => {
	beforeEach( () => {
		jest.resetAllMocks();
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: false, authenticate: jest.fn() } );
		( getIpcApi as jest.Mock ).mockReturnValue( {
			openURL: jest.fn(),
			generateProposedSitePath: jest.fn(),
			showMessageBox: jest.fn(),
		} );
		( useSiteSyncManagement as jest.Mock ).mockReturnValue( {
			connectedSites: [],
			syncSites: [],
		} );
	} );

	const renderWithProvider = ( children: React.ReactElement ) => {
		return render( <SyncSitesProvider>{ children }</SyncSitesProvider> );
	};

	it( 'renders the sync title and login buttons', () => {
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );
		expect( screen.getByText( 'Sync with' ) ).toBeInTheDocument();

		const loginButton = screen.getByRole( 'button', { name: 'Log in to WordPress.com ↗' } );
		expect( loginButton ).toBeInTheDocument();

		fireEvent.click( loginButton );
		expect( useAuth().authenticate ).toHaveBeenCalled();

		const freeAccountButton = screen.getByRole( 'button', { name: 'Create a free account ↗' } );
		expect( freeAccountButton ).toBeInTheDocument();

		fireEvent.click( freeAccountButton );
		expect( getIpcApi().openURL ).toHaveBeenCalled();
	} );

	it( 'displays create new site button to authenticated user', () => {
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: true, authenticate: jest.fn() } );
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );
		const createSiteButton = screen.getByRole( 'button', { name: 'Create new site ↗' } );
		fireEvent.click( createSiteButton );

		expect( screen.getByText( 'Sync with' ) ).toBeInTheDocument();
		expect( createSiteButton ).toBeInTheDocument();
		expect( getIpcApi().openURL ).toHaveBeenCalledWith( 'https://wordpress.com/start/new-site' );
	} );

	it( 'displays connect site button to authenticated user', () => {
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: true, authenticate: jest.fn() } );
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );
		const connectSiteButton = screen.getByRole( 'button', { name: 'Connect site' } );

		expect( connectSiteButton ).toBeInTheDocument();
	} );

	it( 'opens the site selector modal to connect a site authenticated user', () => {
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: true, authenticate: jest.fn() } );
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );
		const connectSiteButton = screen.getByRole( 'button', { name: 'Connect site' } );
		fireEvent.click( connectSiteButton );
		expect( screen.getByText( 'Connect a WordPress.com site' ) ).toBeInTheDocument();
	} );

	it( 'displays the list of connected sites', async () => {
		const fakeSyncSite = {
			id: 6,
			name: 'My simple business site that needs a transfer',
			url: 'https:/developer.wordpress.com/studio/',
			isStaging: false,
			stagingSiteIds: [],
			syncSupport: 'syncable',
		};
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: true, authenticate: jest.fn() } );
		( useSiteSyncManagement as jest.Mock ).mockReturnValue( {
			connectedSites: [ fakeSyncSite ],
			syncSites: [ fakeSyncSite ],
		} );
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );

		const title = screen.getByText( 'My simple business site that needs a transfer' );
		expect( title ).toBeInTheDocument();

		const disconnectButton = screen.getByRole( 'button', { name: 'Disconnect' } );
		expect( disconnectButton ).toBeInTheDocument();

		const pullButton = screen.getByRole( 'button', { name: 'Pull' } );
		expect( pullButton ).toBeInTheDocument();

		const pushButton = screen.getByRole( 'button', { name: 'Push' } );
		expect( pushButton ).toBeInTheDocument();

		const productionText = screen.getByText( 'Production' );
		expect( productionText ).toBeInTheDocument();
	} );

	it( 'opens URL for connected sites', async () => {
		const fakeSyncSite = {
			id: 6,
			name: 'My simple business site that needs a transfer',
			url: 'https:/developer.wordpress.com/studio/',
			isStaging: false,
			stagingSiteIds: [],
			syncSupport: 'syncable',
		};
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: true, authenticate: jest.fn() } );
		( useSiteSyncManagement as jest.Mock ).mockReturnValue( {
			connectedSites: [ fakeSyncSite ],
			syncSites: [ fakeSyncSite ],
		} );
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );

		const urlButton = screen.getByRole( 'button', {
			name: 'https:/developer.wordpress.com/studio/ ↗',
		} );
		expect( urlButton ).toBeInTheDocument();

		fireEvent.click( urlButton );
		expect( getIpcApi().openURL ).toHaveBeenCalledWith( 'https:/developer.wordpress.com/studio/' );
	} );

	it( 'displays both production and staging sites when a production site is connected', async () => {
		const fakeProductionSite = {
			id: 6,
			name: 'My simple business site',
			url: 'https://developer.wordpress.com/studio/',
			isStaging: false,
			stagingSiteIds: [ 7 ],
			syncSupport: 'syncable',
		};
		const fakeStagingSite = {
			id: 7,
			name: 'Staging: My simple business site',
			url: 'https://developer-staging.wordpress.com/studio/',
			isStaging: true,
			stagingSiteIds: [],
			syncSupport: 'syncable',
		};
		( useAuth as jest.Mock ).mockReturnValue( { isAuthenticated: true, authenticate: jest.fn() } );

		( useSiteSyncManagement as jest.Mock ).mockReturnValue( {
			connectedSites: [ fakeProductionSite, fakeStagingSite ],
			syncSites: [ fakeProductionSite ],
		} );
		renderWithProvider( <ContentTabSync selectedSite={ selectedSite } /> );

		// Check for production site
		const productionTitle = screen.getByText( 'My simple business site' );
		expect( productionTitle ).toBeInTheDocument();
		const productionText = screen.getByText( 'Production' );
		expect( productionText ).toBeInTheDocument();

		// Check for staging site where title is not displayed
		const stagingTitle = screen.queryByText( 'Staging: My simple business site' );
		expect( stagingTitle ).not.toBeInTheDocument();
		const stagingText = screen.getByText( 'Staging' );
		expect( stagingText ).toBeInTheDocument();

		// Check for buttons on both sites, with only one disconnect button
		const disconnectButtons = screen.getAllByRole( 'button', { name: 'Disconnect' } );
		expect( disconnectButtons ).toHaveLength( 1 );

		const pullButtons = screen.getAllByRole( 'button', { name: 'Pull' } );
		expect( pullButtons ).toHaveLength( 2 );

		const pushButtons = screen.getAllByRole( 'button', { name: 'Push' } );
		expect( pushButtons ).toHaveLength( 2 );

		// Check for URLs
		const productionUrl = screen.getAllByRole( 'button', {
			name: 'https://developer.wordpress.com/studio/ ↗',
		} );
		expect( productionUrl ).toHaveLength( 1 );

		const stagingUrl = screen.getAllByRole( 'button', {
			name: 'https://developer-staging.wordpress.com/studio/ ↗',
		} );
		expect( stagingUrl ).toHaveLength( 1 );
	} );
} );
