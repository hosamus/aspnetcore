import * as Msal from '@azure/msal-browser';
import { StringDict } from '@azure/msal-common';

interface AccessTokenRequestOptions {
    scopes: string[];
    returnUrl: string;
}

interface AccessTokenResult {
    status: AccessTokenResultStatus;
    token?: AccessToken;
}

interface AccessToken {
    value: string;
    expires: Date;
    grantedScopes: string[];
}

enum AccessTokenResultStatus {
    Success = "success",
    RequiresRedirect = "requiresRedirect"
}

enum AuthenticationResultStatus {
    Redirect = "redirect",
    Success = "success",
    Failure = "failure",
    OperationCompleted = "operationCompleted"
}

interface AuthenticationResult {
    status: AuthenticationResultStatus;
    state?: any;
    message?: string;
}

interface AuthorizeService {
    getUser(): Promise<StringDict | undefined>;
    getAccessToken(request?: AccessTokenRequestOptions): Promise<AccessTokenResult>;
    signIn(state: any): Promise<AuthenticationResult>;
    completeSignIn(state: any): Promise<AuthenticationResult>;
    signOut(state: any): Promise<AuthenticationResult>;
    completeSignOut(url: string): Promise<AuthenticationResult>;
}

interface AuthorizeServiceConfiguration extends Msal.Configuration {
    defaultAccessTokenScopes: string[];
    additionalScopesToConsent: string[];
    loginMode: string;
}

class MsalAuthorizeService implements AuthorizeService {
    private readonly _msalApplication: Msal.PublicClientApplication;
    private _account: Msal.AccountInfo | undefined;

    constructor(private readonly _settings: AuthorizeServiceConfiguration) {
        const callbackUrl = location.href;
        this._msalApplication = new Msal.PublicClientApplication(this._settings);
    }

    getAccount() {
        if (this._account) {
            return this._account;
        }

        const accounts = this._msalApplication.getAllAccounts();
        if (accounts && accounts.length) {
            return accounts[0];
        }

        return null;
    }

    async getUser() {
        const account = this.getAccount();
        if (!account) {
            return;
        }

        const silentRequest = {
            redirectUri: this._settings.auth?.redirectUri,
            account: account,
            scopes: this._settings.defaultAccessTokenScopes
        };

        const response = await this._msalApplication.acquireTokenSilent(silentRequest);
        return response.idTokenClaims;
    }

    async getAccessToken(request?: AccessTokenRequestOptions): Promise<AccessTokenResult> {
        try {
            const newToken = await this.getTokenCore(request?.scopes);
            return {
                status: AccessTokenResultStatus.Success,
                token: newToken
            };
        } catch (e) {
            return {
                status: AccessTokenResultStatus.RequiresRedirect
            };
        }
    }

    async getTokenCore(scopes?: string[]): Promise<AccessToken | undefined> {
        const account = this.getAccount();
        if (!account) {
            return;
        }

        const silentRequest = {
            redirectUri: this._settings.auth?.redirectUri,
            account: account,
            scopes: scopes || this._settings.defaultAccessTokenScopes
        };

        const response = await this._msalApplication.acquireTokenSilent(silentRequest);
        return {
            value: response.accessToken,
            grantedScopes: response.scopes,
            expires: response.expiresOn
        };
    }

    async signIn(state: any) {
        try {
            // Before we start any sign-in flow, clear out any previous state so that it doesn't pile up.
            this.purgeState();

            const request: Msal.AuthorizationUrlRequest = {
                redirectUri: this._settings.auth?.redirectUri,
                state: await this.saveState(state),
                scopes: []
            };

            if (this._settings.defaultAccessTokenScopes && this._settings.defaultAccessTokenScopes.length > 0) {
                request.scopes = this._settings.defaultAccessTokenScopes;
            }

            if (this._settings.additionalScopesToConsent && this._settings.additionalScopesToConsent.length > 0) {
                request.extraScopesToConsent = this._settings.additionalScopesToConsent;
            }

            const result = await this.signInCore(request);
            if (!result) {
                return this.redirect();
            } else if (this.isMsalError(result)) {
                return this.error(result.errorMessage);
            }

            try {
                if (this._settings.defaultAccessTokenScopes?.length > 0) {
                    // This provisions the token as part of the sign-in flow eagerly so that is already in the cache
                    // when the app asks for it.
                    const account = this.getAccount();
                    if (!account) {
                        return this.error("No account to get tokens with.");
                    }
                    const silentRequest = {
                        redirectUri: request.redirectUri,
                        account: account,
                        scopes: request.scopes,
                    };
                    await this._msalApplication.acquireTokenSilent(silentRequest);
                }
            } catch (e) {
                return this.error(e.errorMessage);
            }

            return this.success(state);
        } catch (e) {
            return this.error(e.message);
        }
    }

    async signInCore(request: Msal.AuthorizationUrlRequest): Promise<Msal.AuthenticationResult | Msal.AuthError | undefined> {
        const loginMode = this._settings.loginMode.toLowerCase();
        if (loginMode === 'redirect') {
            return this.signInWithRedirect(request);
        } else {
            return this.signInWithPopup(request);
        }
    }

    private async signInWithRedirect(request: Msal.RedirectRequest) {
        try {
            this._msalApplication.loginRedirect(request);
        } catch (e) {
            return e;
        }
    }

    private async signInWithPopup(request: Msal.PopupRequest) {
        try {
            return await this._msalApplication.loginPopup(request);
        } catch (e) {
            // If the user explicitly cancelled the pop-up, avoid performing a redirect.
            if (this.isMsalError(e) && e.errorCode !== Msal.BrowserAuthErrorMessage.userCancelledError.code) {
                this.signInWithRedirect(request);
            } else {
                return e;
            }
        }
    }

    async completeSignIn() {
        const account = this.getAccount();
        if (account) {
            return this.success(account);
        }
        return this.operationCompleted();
    }

    async signOut(state: any) {
        // We are about to sign out, so clear any state before we do so and leave just the sign out state for
        // the current sign out flow.
        this.purgeState();

        const logoutStateId = await this.saveState(state);

        // msal.js doesn't support providing logout state, so we shim it by putting the identifier in session storage
        // and using that on the logout callback to workout the problems.
        sessionStorage.setItem(`${AuthenticationService._infrastructureKey}.LogoutState`, logoutStateId);

        this._msalApplication.logout();

        // We are about to be redirected.
        return this.redirect();
    }

    async completeSignOut(url: string) {
        const logoutStateId = sessionStorage.getItem(`${AuthenticationService._infrastructureKey}.LogoutState`);
        const updatedUrl = new URL(url);
        updatedUrl.search = `?state=${logoutStateId}`;
        const logoutState = await this.retrieveState(updatedUrl.href, /*isLogout*/ true);

        sessionStorage.removeItem(`${AuthenticationService._infrastructureKey}.LogoutState`);

        if (logoutState) {
            return this.success(logoutState);
        } else {
            return this.operationCompleted();
        }
    }

    // msal.js only allows a string as the account state and it simply attaches it to the sign-in request state.
    // Given that we don't want to serialize the entire state and put it in the query string, we need to serialize the
    // state ourselves and pass an identifier to retrieve it while in the callback flow.
    async saveState<T>(state: T): Promise<string> {
        const base64UrlIdentifier = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = evt => resolve((evt?.target?.result as string)
                // The result comes back as a base64 string inside a dataUrl.
                // We remove the prefix and convert it to base64url by replacing '+' with '-', '/' with '_' and removing '='.
                .split(',')[1].replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''));
            reader.onerror = evt => reject(evt.target?.error?.message);

            // We generate a base 64 url encoded string of random data.
            const entropy = window.crypto.getRandomValues(new Uint8Array(32));
            reader.readAsDataURL(new Blob([entropy]));
        });

        sessionStorage.setItem(`${AuthenticationService._infrastructureKey}.AuthorizeService.${base64UrlIdentifier}`, JSON.stringify(state));
        return base64UrlIdentifier;
    }

    async retrieveState<T>(url: string, isLogout: boolean = false): Promise<T | undefined> {
        const parsedUrl = new URL(url);
        const fromHash = parsedUrl.hash && parsedUrl.hash.length > 0 && new URLSearchParams(parsedUrl.hash.substring(1));
        let state = fromHash && fromHash.getAll('state');
        if (state && state.length > 1) {
            return undefined;
        } else if (!state || state.length == 0) {
            state = parsedUrl.searchParams && parsedUrl.searchParams.getAll('state');
            if (!state || state.length !== 1) {
                return undefined;
            }
        }

        // We need to calculate the state key in two different ways. The reason for it is that
        // msal.js doesn't support the state parameter on logout flows, which forces us to shim our own logout state.
        // The format then is different, as msal follows the pattern state=<<guid>>|<<user_state>> and our format
        // simple uses <<base64urlIdentifier>>.
        const appState = !isLogout ? this.getAccountState(state[0]) : state[0];
        const stateKey = `${AuthenticationService._infrastructureKey}.AuthorizeService.${appState}`;
        const stateString = sessionStorage.getItem(stateKey);
        if (stateString) {
            sessionStorage.removeItem(stateKey);
            const savedState = JSON.parse(stateString);
            return savedState;
        }

        return undefined;
    }

    purgeState() {
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key?.startsWith(AuthenticationService._infrastructureKey)) {
                sessionStorage.removeItem(key);
            }
        }
    }

    async initializeMsalHandler() {
        this._msalApplication.handleRedirectPromise().then(
            (result: Msal.AuthenticationResult | null) => this.handleResult(result)
        ).catch((error: any) => {
            if (this.isMsalError(error)) {
                return this.error(error.errorMessage);
            } else {
                return this.error(error);
            }
        })
    }

    private handleResult(result: Msal.AuthenticationResult | null) {
        if (window !== window.parent && !window.opener) {
            return this.operationCompleted();
        } else {
            if (result != null) {
                this._account = result.account;
                return this.success(result.state);
            } else {
                console.log(this.getAccount());
            }
        }
    }

    private getAccountState(state: string) {
        if (state) {
            const splitIndex = state.indexOf("|");
            if (splitIndex > -1 && splitIndex + 1 < state.length) {
                return state.substring(splitIndex + 1);
            }
        }
        return state;
    }

    private isMsalError(resultOrError: any): resultOrError is Msal.AuthError {
        return resultOrError?.errorCode;
    }

    private error(message: string) {
        return { status: AuthenticationResultStatus.Failure, errorMessage: message };
    }

    private success(state: any) {
        return { status: AuthenticationResultStatus.Success, state };
    }

    private redirect() {
        return { status: AuthenticationResultStatus.Redirect };
    }

    private operationCompleted() {
        return { status: AuthenticationResultStatus.OperationCompleted };
    }
}

export class AuthenticationService {

    static _infrastructureKey = 'Microsoft.Authentication.WebAssembly.Msal';
    static _initialized = false;
    static instance: MsalAuthorizeService;

    public static async init(settings: AuthorizeServiceConfiguration) {
        if (!AuthenticationService._initialized) {
            AuthenticationService._initialized = true;
            AuthenticationService.instance = new MsalAuthorizeService(settings);
            await AuthenticationService.instance.initializeMsalHandler();
        }
    }

    public static getUser() {
        return AuthenticationService.instance.getUser();
    }

    public static getAccessToken(request: AccessTokenRequestOptions) {
        return AuthenticationService.instance.getAccessToken(request);
    }

    public static signIn(state: any) {
        return AuthenticationService.instance.signIn(state);
    }

    // url is not used in the msal.js implementation but we keep it here
    // as it is part of the default RemoteAuthenticationService contract implementation.
    // The unused parameter here just reflects that.
    public static completeSignIn(url: string) {
        return AuthenticationService.instance.completeSignIn();
    }

    public static signOut(state: any) {
        return AuthenticationService.instance.signOut(state);
    }

    public static completeSignOut(url: string) {
        return AuthenticationService.instance.completeSignOut(url);
    }
}

declare global {
    interface Window { AuthenticationService: AuthenticationService; }
}

window.AuthenticationService = AuthenticationService;
