var spaHome = Vue.component("Home", {
    template: /*html*/`
<div>
    <div style="margin-bottom: 10px;"></div>
    <div v-if="id !== null">
        <b-jumbotron header="NagBot Welcomes You" :lead="displayName + ', how can I help?'">
        <p>Your id is {{ id }}</p>
        </b-jumbotron>
    </div>
    <div v-else>
        You are not logged in. Please <a href="/login">login</a>
    </div>
</div>`,
    props: ["title"],
    data() {
        return {
            displayName: null,
            id: null
        };
    },
    created() {
        this.GetUser();
    },
    methods: {
        GetUser() {
            window.fetch("/api/v1.0/me")
                .then(response => {
                    if (response.status != 200) return null;
                    return response.json();
                }).then(json => {
                    if (json) {
                        this.displayName = json.displayName;
                        this.id = json.id;
                    }
                    return
                })
                .catch(err => {
                    console.error('Error', err);
                });

            this.progress = true;
            this.ready = true;

            this.user = { preferredName: 'Nag Tester' };
        }
    }
});
